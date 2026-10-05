// Packaging for macOS, Windows and Linux. macOS is signed with the Developer ID identity and, when
// APPLE_KEYCHAIN_PROFILE is set (npm run deploy), notarized. Windows and Linux are unsigned.
// Secrets come from electron-builder.env (gitignored), which the electron-builder CLI loads first.
const fs = require("node:fs");
const path = require("node:path");

// Where installed apps look for updates. Baked into each build's app-update.yml, so a build keeps
// polling the repo it was built with. A value already in the environment wins over the file.
// Checked first: electron-builder reads an ENOENT thrown here as "no config file" and would build
// with its defaults instead of failing.
const releaseEnv = path.join(__dirname, "release.env");
if (fs.existsSync(releaseEnv)) process.loadEnvFile(releaseEnv);
const { owner, repo } = githubRepo(process.env.GH_REPO_URL);

module.exports = {
  appId: "com.goopter.smartpos",
  productName: "Goopter Smart POS",
  directories: { output: "release" },
  files: ["dist/**/*.js", "renderer/**/*", "package.json"],
  publish: { provider: "github", owner, repo },
  mac: {
    // The zip is what an installed app downloads to update itself. The dmg is for first installs.
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    category: "public.app-category.business",
    hardenedRuntime: true,
    notarize: true,
    extendInfo: {
      // Shown in the macOS 15+ Local Network prompt, which gates every print (SPEC §8.2).
      NSLocalNetworkUsageDescription:
        "Goopter Smart POS sends receipts and kitchen tickets to printers on the store network.",
    },
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    // Writes raw bytes to printers installed on the till (USB_PRINTING_SPEC). Built by build:rawprint.
    extraResources: [{ from: "dist/native/rawprint.exe", to: "rawprint.exe" }],
    // Unsigned. Without this, Windows falls back to CSC_LINK, which is the Apple certificate.
    cscLink: "",
  },
  linux: {
    // Explicit, or a build on an Apple Silicon Mac produces arm64 packages.
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
    category: "Office",
    maintainer: "Goopter",
  },
};

function githubRepo(url) {
  if (!url) throw new Error("GH_REPO_URL is not set. It belongs in release.env.");
  const parsed = new URL(url);
  const parts = parsed.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parsed.hostname !== "github.com" || parts.length !== 2) {
    throw new Error(`GH_REPO_URL must look like https://github.com/<owner>/<repo>, got ${url}`);
  }
  return { owner: parts[0], repo: parts[1] };
}
