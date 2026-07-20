import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { google } from "googleapis";
import { config } from "../config.js";

const scopes = [
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/drive.file"
];

type OAuthCredentials = {
  installed?: OAuthClientConfig;
  web?: OAuthClientConfig;
};

type OAuthClientConfig = {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
};

export async function getGoogleAuthClient() {
  if (config.google.authMode === "oauth" && existsSync(config.google.oauthToken)) {
    return getOAuthClientFromToken();
  }

  return google.auth.getClient({
    scopes
  });
}

export async function authorizeGoogleOAuth() {
  const authUrl = await getGoogleOAuthUrl();

  console.log("Open this URL in your browser:");
  console.log(authUrl);

  const rl = createInterface({ input, output });
  const code = await rl.question("Paste the authorization code: ");
  rl.close();

  await saveGoogleOAuthCode(code);
}

export async function getGoogleOAuthUrl() {
  const client = await createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent"
  });
}

export async function saveGoogleOAuthCode(code: string) {
  const client = await createOAuthClient();
  const { tokens } = await client.getToken(code.trim());
  client.setCredentials(tokens);

  await writeFile(config.google.oauthToken, JSON.stringify(tokens, null, 2), "utf8");
  console.log(`Saved OAuth token to ${config.google.oauthToken}`);
}

async function getOAuthClientFromToken() {
  const client = await createOAuthClient();
  const token = JSON.parse(await readFile(config.google.oauthToken, "utf8"));
  client.setCredentials(token);
  return client;
}

async function createOAuthClient() {
  const credentials = JSON.parse(await readFile(config.google.oauthCredentials, "utf8")) as OAuthCredentials;
  const configBlock = credentials.installed ?? credentials.web;

  if (!configBlock) {
    throw new Error("OAuth credentials must contain either an installed or web client config.");
  }

  return new google.auth.OAuth2(
    configBlock.client_id,
    configBlock.client_secret,
    configBlock.redirect_uris[0]
  );
}
