#!/usr/bin/env bun
//MISE description="Create the git tag and GitHub Release for the current version"
//MISE dir="{{ config_root }}"
//MISE depends=["build"]

import { version } from '@repo/package.json' with { type: 'json' };
import { tagAndGithubRelease } from 'bun-release';

await tagAndGithubRelease(version);
