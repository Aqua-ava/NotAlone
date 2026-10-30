export function appMinimumMacOS(appPlatform) {
  const version = appPlatform?.minimumMacOS;
  if (typeof version !== 'string' || version !== version.trim() || !/^[1-9]\d{0,2}\.(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2}))?$/.test(version)) {
    throw new Error('app_minimum_macos_invalid');
  }
  return version;
}
