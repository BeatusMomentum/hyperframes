/** The platforms sherpa-onnx-node publishes a native package for. */
const SUPPORTED_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-ia32",
];

interface Host {
  platform: string;
  arch: string;
  glibc?: string;
}

function currentHost(): Host {
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  return {
    platform: process.platform,
    arch: process.arch,
    glibc: report.header?.glibcVersionRuntime,
  };
}

/** Why sherpa-onnx cannot run here, or null. Its Linux prebuilt needs glibc 2.32 (so no musl). */
export function sherpaUnsupportedReason(host: Host = currentHost()): string | null {
  const target = `${host.platform}-${host.arch}`;
  if (!SUPPORTED_TARGETS.includes(target)) {
    return `Parakeet runs on ${SUPPORTED_TARGETS.join(", ")}; this system is ${target}.`;
  }
  if (host.platform !== "linux") return null;
  if (!host.glibc) return "Parakeet needs glibc 2.32 or newer; this Linux has no glibc (musl?).";
  const [major = 0, minor = 0] = host.glibc.split(".").map(Number);
  if (major > 2 || (major === 2 && minor >= 32)) return null;
  return `Parakeet needs glibc 2.32 or newer; this system has glibc ${host.glibc}.`;
}
