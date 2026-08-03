// ============================================================================
// Finding `keytool`.
//
// One copy, because there were three and they disagreed: the doctor took the
// first JDK it found while `signing:newkey` preferred 17–21, so the two could
// report on different keystores' worth of behaviour on the same machine.
//
// `keytool` is never on PATH on a normal Windows box — it lives inside whichever
// JDK happens to be installed, under a path with a space in it. AGP only
// supports 17–21 for the BUILD, so those are preferred here for consistency,
// but any JDK's keytool can make and read a PKCS12 store, so a newer one is
// taken rather than failing.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = [
  'C:\\Program Files\\Eclipse Adoptium',
  'C:\\Program Files\\Java',
  'C:\\Program Files\\Android\\Android Studio',
];

/** Absolute path to a `keytool.exe`, or null. */
export function findKeytool() {
  const hits = [];
  if (process.env.JAVA_HOME) {
    const k = path.join(process.env.JAVA_HOME, 'bin', 'keytool.exe');
    if (fs.existsSync(k)) hits.push({ path: k, major: 99 });
  }
  for (const r of ROOTS) {
    if (!fs.existsSync(r)) continue;
    for (const n of fs.readdirSync(r)) {
      const m = /(\d+)/.exec(n);
      // `jbr` is Android Studio's bundled runtime, which is a JDK in every way
      // that matters here and is present on machines with no standalone JDK.
      for (const c of [path.join(r, n), path.join(r, n, 'jbr')]) {
        const k = path.join(c, 'bin', 'keytool.exe');
        if (fs.existsSync(k)) hits.push({ path: k, major: m ? parseInt(m[1], 10) : 0 });
      }
    }
  }
  if (!hits.length) return null;
  const supported = hits.filter((h) => h.major >= 17 && h.major <= 21);
  return (supported[0] ?? hits[0]).path;
}
