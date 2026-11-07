export const IS_LOCAL_DEV = import.meta.env?.DEV === true;

export function publicUrl(path: string, base = import.meta.env?.BASE_URL ?? '/'): string {
  if (/^https?:\/\//.test(path)) return path;
  return base.replace(/\/?$/, '/') + path.replace(/^\/+/, '');
}

export function snapshotUrls(platform: string, local = IS_LOCAL_DEV, base?: string): string[] {
  const snapshot = publicUrl('data/' + platform + '-tag-counts.json', base);
  return local ? ['/api/' + platform + '/tag-counts', snapshot] : [snapshot];
}
