import { access } from "node:fs/promises";

const requiredFiles = ["src/index.html", "src/styles.css", "src/app.js"];

await Promise.all(requiredFiles.map((file) => access(new URL(`../${file}`, import.meta.url))));
console.log("web build ok: static assets are ready");
