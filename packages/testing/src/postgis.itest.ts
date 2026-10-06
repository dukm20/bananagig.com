import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Database } from '@bananagig/database';
import { createIsolatedDatabase, rejection, type IsolatedDatabase } from './index';

// Proves the conventions in docs/data/DATABASE_CONVENTIONS.md (PostGIS section) work as written. Scratch tables only.
let iso: IsolatedDatabase;
let db: Database;
beforeAll(async () => {
  iso = await createIsolatedDatabase();
  db = iso.database;
  await db.query(`CREATE TABLE geo_probe (
    geo_probe_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location geography(Point, 4326) NOT NULL,
    service_area geography(MultiPolygon, 4326),
    CONSTRAINT ck_geo_probe__service_area_valid CHECK (service_area IS NULL OR ST_IsValid(service_area::geometry))
  )`);
  await db.query('CREATE INDEX idx_geo_probe__location ON geo_probe USING GIST (location)');
  await db.query('CREATE INDEX idx_geo_probe__service_area ON geo_probe USING GIST (service_area)');
});
afterAll(async () => {
  await iso.drop();
});

// Points are built longitude FIRST: ST_MakePoint(lng, lat).
const point = (lng: number, lat: number) => sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;

describe('PostGIS conventions', () => {
  it('stores points as geography(Point,4326) with SRID 4326', async () => {
    await db.transaction((trx) => sql`INSERT INTO geo_probe (location) VALUES (${point(-122.4194, 37.7749)})`.execute(trx)); // San Francisco
    const r = await db.query<{ srid: number; type: string }>(
      'SELECT ST_SRID(location::geometry) AS srid, GeometryType(location::geometry) AS type FROM geo_probe LIMIT 1',
    );
    expect(r[0]).toEqual({ srid: 4326, type: 'POINT' });
  });
  it('measures distance in meters on the spheroid and filters with ST_DWithin (meters)', async () => {
    const d = (await sql<{ m: number }>`SELECT ST_Distance(${point(0, 0)}, ${point(0, 1)})::float AS m`.execute(db.db)).rows[0]!.m;
    expect(Math.round(d)).toBeGreaterThan(110000);
    expect(Math.round(d)).toBeLessThan(112000); // one degree of latitude is about 111 km
    const within = async (meters: number) =>
      (await sql<{ ok: boolean }>`SELECT ST_DWithin(${point(0, 0)}, ${point(0, 1)}, ${meters}) AS ok`.execute(db.db)).rows[0]!.ok;
    expect(await within(120_000)).toBe(true);
    expect(await within(100_000)).toBe(false);
  });
  it('uses the GiST index for radius queries', async () => {
    await db.query(
      `INSERT INTO geo_probe (location) SELECT ST_SetSRID(ST_MakePoint(-180 + random() * 360, -80 + random() * 160), 4326)::geography FROM generate_series(1, 3000)`,
    );
    await db.query('ANALYZE geo_probe');
    const plan = await db.transaction(async (trx) => {
      await sql`SET LOCAL enable_seqscan = off`.execute(trx); // prove the index is usable (tiny tables prefer seq scans otherwise)
      const r = await sql<{ 'QUERY PLAN': string }>`EXPLAIN SELECT 1 FROM geo_probe WHERE ST_DWithin(location, ${point(-122.4, 37.8)}, 5000)`.execute(trx);
      return r.rows.map((x) => x['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('idx_geo_probe__location');
  });
  it('stores service areas as geography(MultiPolygon,4326) and answers containment with ST_Covers', async () => {
    const square = sql`ST_Multi(ST_GeomFromText('POLYGON((-122.5 37.7, -122.3 37.7, -122.3 37.9, -122.5 37.9, -122.5 37.7))', 4326))::geography`;
    await db.transaction((trx) => sql`INSERT INTO geo_probe (location, service_area) VALUES (${point(-122.4, 37.8)}, ${square})`.execute(trx));
    const covers = async (lng: number, lat: number) =>
      (
        await sql<{ n: string }>`SELECT count(*) AS n FROM geo_probe WHERE service_area IS NOT NULL AND ST_Covers(service_area, ${point(lng, lat)})`.execute(
          db.db,
        )
      ).rows[0]!.n;
    expect(await covers(-122.4, 37.8)).toBe('1');
    expect(await covers(-121.0, 37.8)).toBe('0');
  });
  it('rejects invalid polygons (self-intersecting bow-tie) via the validity check', async () => {
    const bowtie = sql`ST_Multi(ST_GeomFromText('POLYGON((0 0, 1 1, 1 0, 0 1, 0 0))', 4326))::geography`;
    const err = (await rejection(
      db.transaction((trx) => sql`INSERT INTO geo_probe (location, service_area) VALUES (${point(0, 0)}, ${bowtie})`.execute(trx)),
    )) as { code?: string };
    expect(err.code).toBe('23514');
  });
  it('shows why latitude/longitude must be validated BEFORE building a point (the database coerces silently)', async () => {
    // Out-of-range input is coerced into range by PostGIS instead of failing, so a CHECK on the stored value cannot catch it.
    const lat = (await sql<{ lat: number }>`SELECT ST_Y(${point(10, 91)}::geometry) AS lat`.execute(db.db)).rows[0]!.lat;
    expect(lat).toBeLessThanOrEqual(90);
    expect(lat).not.toBe(91);
  });
});
