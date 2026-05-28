/**
 * Platform dispatcher. The remote URL is the only signal we use to pick
 * GitHub vs GitLab — substring "gitlab" anywhere in the URL is the
 * GitLab marker; everything else is treated as GitHub. This is a
 * deliberately broad rule so self-hosted instances on subdomains like
 * `gitlab.acme.com` or `code.example.org/gitlab` are recognized without
 * a host allowlist.
 */

import { githubPlatform } from "./platforms/github";
import { gitlabPlatform } from "./platforms/gitlab";
import type { Platform, PrPlatform } from "./types";

export function detectPlatformName(remoteUrl: string): Platform {
  return /gitlab/i.test(remoteUrl) ? "gitlab" : "github";
}

export function getPlatform(name: Platform): PrPlatform {
  return name === "gitlab" ? gitlabPlatform : githubPlatform;
}

export function detectPlatform(remoteUrl: string): PrPlatform {
  return getPlatform(detectPlatformName(remoteUrl));
}
