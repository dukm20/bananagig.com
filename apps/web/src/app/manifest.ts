import type { MetadataRoute } from 'next';

// PWA-capable: manifest only. No service worker or offline behaviour until a feature needs it (DEBT-0003).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'BananaGig',
    short_name: 'BananaGig',
    description: 'Local help. Done fast.',
    start_url: '/',
    display: 'standalone',
    background_color: '#fffdf5',
    theme_color: '#f5c518',
    icons: [],
  };
}
