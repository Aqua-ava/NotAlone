import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BindingFixture } from './binding-backend-fixture';

export async function prepareObservationMeasurements(fixture: BindingFixture, probe: string) {
  const measurementFile = path.join(fixture.directory, 'observation-measurements.jsonl');
  await writeFile(measurementFile, '', { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(fixture.directory, 'observation_measurements.py'),
    await readFile(path.resolve('tests/fixtures/observation_measurements.py')), { mode: 0o600 });
  await writeFile(path.join(fixture.directory, 'sitecustomize.py'),
    'import sys\nif sys.orig_argv[1:3] == ["-m", "notalone.server.command"]:\n    from observation_measurements import install\n    install()\n',
    { mode: 0o600 });
  const environment = fixture.environment.bind(fixture);
  fixture.environment = owner => ({ ...environment(owner), NOTALONE_SYNC_PROBE: probe,
    NOTALONE_OBSERVATION_MEASUREMENTS: '1', NOTALONE_OBSERVATION_MEASUREMENT_FILE: measurementFile,
    PYTHONPATH: `${fixture.directory}${path.delimiter}${environment(owner).PYTHONPATH}` });
}

export async function readObservationMeasurements(fixture: BindingFixture) {
  return (await readFile(path.join(fixture.directory, 'observation-measurements.jsonl'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}
