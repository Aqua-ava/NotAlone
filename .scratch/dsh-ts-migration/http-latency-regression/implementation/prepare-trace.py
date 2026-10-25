from pathlib import Path
import os
base=Path(__file__).resolve().parent
repo=base.parents[3]
source=(repo/'backend-ts/src/host-storage.ts').read_text()
trace=base/'trace-source'
trace.mkdir(mode=0o700,exist_ok=True)
modules=trace/'node_modules'
if not modules.exists(): modules.symlink_to(repo/'backend-ts/node_modules',target_is_directory=True)
source="const perfRows = globalThis[Symbol.for('notalone.storage.trace')] = [];\n"+source
source=source.replace("client = await connectConfigured(await connectionOptions(this.databaseUrl, this.values));", """const connectStart = performance.now();
      client = await connectConfigured(await connectionOptions(this.databaseUrl, this.values));
      perfRows.push({stage:'connect',milliseconds:performance.now()-connectStart});
      const originalQuery = client.query;
      client.query = function(...args) {
        const start = performance.now();
        const result = Reflect.apply(originalQuery,this,args);
        return result.then(value => {perfRows.push({stage:'sql',label:String(args[0]).slice(0,55),milliseconds:performance.now()-start}); return value;});
      };""")
source=source.replace('let migrations: {name: string; checksum: string}[];', 'const filesStart = performance.now();\n    let migrations: {name: string; checksum: string}[];')
source=source.replace('const metadata = await client.query', "perfRows.push({stage:'files',milliseconds:performance.now()-filesStart});\n    const metadata = await client.query")
source=source.replace('} finally { await client?.end().catch(() => {}); this.pending.delete(pending); finish(); }', "} finally { const endStart=performance.now(); await client?.end().catch(() => {}); perfRows.push({stage:'end',milliseconds:performance.now()-endStart}); this.pending.delete(pending); finish(); }")
(trace/'host-storage.ts').write_text(source)
loop=(base/'storage-loop.mjs').read_text().replace("'../../../../backend-ts/src/host-storage.ts'", "'./trace-source/host-storage.ts'")
loop=loop.replace('samples, stages, p50_ms', "samples, stages, trace_rows:globalThis[Symbol.for('notalone.storage.trace')], p50_ms")
loop=loop.replace("trace ? 'storage-trace.json' : 'storage-loop.json'", "'storage-trace.json'")
(base/'trace-loop.mjs').write_text(loop)
