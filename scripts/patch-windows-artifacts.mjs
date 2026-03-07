import fs from "node:fs";
import path from "node:path";
import { rcedit } from "rcedit";

const rootDir = process.cwd();
const packageJsonPath = path.join(rootDir, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const iconPath = path.join(rootDir, "build", "icon.ico");

const targets = [
  path.join(rootDir, "release", "win-unpacked", "TermBag.exe"),
  path.join(rootDir, "release", "TermBag.exe"),
];

const versionStrings = {
  CompanyName: String(packageJson.author ?? "TobiasM95"),
  FileDescription: "TermBag",
  InternalName: "TermBag",
  OriginalFilename: "TermBag.exe",
  ProductName: "TermBag",
};

for (const targetPath of targets) {
  if (!fs.existsSync(targetPath)) {
    continue;
  }

  await rcedit(targetPath, {
    icon: iconPath,
    "version-string": versionStrings,
  });

  console.log(`Patched Windows resources for ${path.relative(rootDir, targetPath)}`);
}
