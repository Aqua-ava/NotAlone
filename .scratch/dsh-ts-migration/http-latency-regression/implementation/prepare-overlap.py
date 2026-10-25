from pathlib import Path
base=Path(__file__).resolve().parent
repo=base.parents[3]
source=(repo/'backend-ts/src/host-storage.ts').read_text()
start=source.index('    let migrations: {name: string; checksum: string}[];')
end=source.index('    const tables = new Map', start)
source=source[:start]+'''    let names: string[];
    try {
      names = (await readdir(this.options.migrationsDirectory)).filter(name => name.endsWith('.sql')).sort();
      if (names.length !== EXPECTED_MIGRATION_COUNT || names.some((name, i) => !new RegExp(`^${String(i + 1).padStart(3, '0')}_[a-z0-9_]+\\\\.sql$`).test(name))) return 'migration_files_invalid';
    } catch { return 'migration_files_invalid'; }
    const [files, catalog] = await Promise.allSettled([
      Promise.all(names.map(async name => ({ name, checksum: createHash('sha256').update(await readFile(join(this.options.migrationsDirectory, name))).digest('hex') }))),
      client.query(`SELECT c.relname,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS kind
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`),
    ]);
    if (files.status === 'rejected') return 'migration_files_invalid';
    if (catalog.status === 'rejected') throw catalog.reason;
    const migrations = files.value, metadata = catalog.value;
''' +source[end:]
trace=base/'trace-source'
(trace/'overlap-storage.ts').write_text(source)
loop=(base/'storage-loop.mjs').read_text().replace("'../../../../backend-ts/src/host-storage.ts'", "'./trace-source/overlap-storage.ts'").replace("trace ? 'storage-trace.json' : 'storage-loop.json'", "'storage-overlap.json'")
(base/'overlap-loop.mjs').write_text(loop)
