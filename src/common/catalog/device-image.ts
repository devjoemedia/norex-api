// Device photos live on the website (public/devices/…); the catalog keeps their paths
// in specs.webImages. Turns one into a full URL the portal can show, or null.
export function deviceImageUrl(specs: unknown, base: string | undefined): string | null {
  const web = (specs as { webImages?: { cutout?: string; image?: string } } | null)?.webImages;
  const path = web?.cutout ?? web?.image;
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
