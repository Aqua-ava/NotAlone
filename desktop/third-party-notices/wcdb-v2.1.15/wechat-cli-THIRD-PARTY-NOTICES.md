# Third-Party Notices

wechat-cli source code does not commit third-party binary libraries.

Release zips may bundle `libWCDB.dylib` / `libWCDB.dll` so the CLI can load Tencent WCDB at runtime. WCDB is an upstream Tencent project; see its repository and license:

- https://github.com/Tencent/wcdb
- https://github.com/Tencent/wcdb/blob/master/LICENSE

`libWCDB.dylib` / `libWCDB.dll` is loaded locally by wechat-cli for read-only access to the user's own WeChat databases.

Optional voice transcription setup (`wechat-cli asr setup` or installer
`--with-asr`) creates a user-local Python virtualenv and downloads packages from
PyPI. These packages are not bundled in wechat-cli release zips:

- `faster-whisper` for local ASR.
- `silk-python` / `pysilk` for local WeChat SILK decode fallback.
