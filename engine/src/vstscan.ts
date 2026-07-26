// ============================================================================
// VST3 plugin scanner — a throwaway child process, so a crashing plugin can
// never take down the app (plugins routinely crash during factory scans).
//
// Usage: node dist-engine/vstscan.js <vsthost.node path>
//   stdin:  JSON array of module paths to scan
//   stdout: one JSON line per module:
//     {"op":"scanning","path":...}          announced before loading (so the
//                                            parent knows who crashed)
//     {"op":"result","path":...,"classes":[{cid,name,vendor,version,subCategories}]}
//     {"op":"error","path":...,"error":...}
//     {"op":"done"}
// The parent (electron main.cjs) respawns with the remainder after a crash and
// blacklists the module that was in flight.
// ============================================================================

interface ScanClass {
  cid: string;
  name: string;
  vendor: string;
  version: string;
  subCategories: string;
}
interface ScanAddon {
  moduleClasses(path: string): ScanClass[];
}

const emit = (o: object): void => void process.stdout.write(JSON.stringify(o) + '\n');

async function main(): Promise<void> {
  const addonPath = process.argv[2];
  if (!addonPath) {
    emit({ op: 'error', path: '', error: 'usage: vstscan <vsthost.node> (paths on stdin)' });
    process.exit(2);
  }
  let addon: ScanAddon;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    addon = require(addonPath) as ScanAddon;
  } catch (err) {
    emit({ op: 'error', path: addonPath, error: 'addon load failed: ' + String(err) });
    process.exit(2);
  }

  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let paths: string[] = [];
  try {
    paths = JSON.parse(Buffer.concat(chunks).toString('utf8')) as string[];
  } catch {
    emit({ op: 'error', path: '', error: 'bad stdin (expected JSON array of paths)' });
    process.exit(2);
  }

  for (const p of paths) {
    emit({ op: 'scanning', path: p });
    try {
      const classes = addon!.moduleClasses(p);
      emit({ op: 'result', path: p, classes });
    } catch (err) {
      emit({ op: 'error', path: p, error: String(err) });
    }
  }
  emit({ op: 'done' });
  // Skip module teardown: some plugin DLLs crash in static destructors, and a
  // non-zero exit here would look like a scan failure. Hard-exit while sane.
  process.exit(0);
}

void main();
