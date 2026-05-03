import { saveGoogleOAuthCode } from "../services/googleAuth.js";

const code = process.argv[2];

if (!code) {
  throw new Error("Usage: npm run google:oauth:code -- <authorization-code>");
}

await saveGoogleOAuthCode(code);
