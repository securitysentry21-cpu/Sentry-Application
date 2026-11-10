import type { MetadataRoute } from 'next';

// The dashboard installs to the home screen (PROD §11.5, D-04): on iPhone and iPad, web push reaches
// only a dashboard installed that way and opened from there. Next.js serves this at
// /manifest.webmanifest and links it from every page. No icons yet: the wordmark is unreadable at
// icon size and the app icon is still to be designed (design/README.md, open item 4); until then a
// phone uses a picture of the page.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'SENTRY',
    short_name: 'SENTRY',
    description: 'Security guard operations dashboard',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#17181b',
    theme_color: '#17181b',
  };
}
