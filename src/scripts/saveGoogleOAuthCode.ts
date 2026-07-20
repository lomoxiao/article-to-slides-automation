import { saveGoogleOAuthCode } from "../shared/googleAuth.js";
import { usage } from "./lib/cli.js";

const code = process.argv[2];

if (!code) {
  usage("Usage: npm run google:oauth:code -- <authorization-code>");
}

await saveGoogleOAuthCode(code);
