// Authentication and the token's owner.
//
// The suite presents `Authorization: Bearer <token>` where the token is the
// one in this process's MAKEFUN_SHOP_TOKEN. A request without it (or with a
// different one) is 401. The token names one login — the viewer — and a
// repository belongs to that login, so the same repository name under another
// owner is 404, never 403.
//
// The entry is never told the login directly. It learns it from the first
// owner-bearing request it serves (a git path or a REST path naming an owner):
// every suite request that names an owner names the viewer, except the one
// foreign-owner check, which first reads the same repository under the viewer.
// By the time any check names another owner, the viewer is already learned.

import type { IncomingMessage } from 'node:http';

/** The token the suite presents, from this process's environment. */
export const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** True when the request carries the suite's bearer token. */
export function isAuthenticated(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented === '') return false;
  // With a token configured, only that token counts; without one (a local
  // run that never set it), any non-empty bearer is the suite's.
  return SHOP_TOKEN === '' ? true : presented === SHOP_TOKEN;
}

/**
 * The viewer login, learned from the first owner-bearing request. Null until
 * the first such request arrives.
 */
export class Viewer {
  private login: string | null = null;

  /** The learned login, or null when nothing has named an owner yet. */
  get current(): string | null {
    return this.login;
  }

  /** Record an owner as the viewer, the first time one is seen. */
  learn(owner: string): string {
    if (this.login === null) this.login = owner;
    return this.login;
  }

  /**
   * Whether `owner` is the token's owner. The first owner seen becomes the
   * viewer (and is the viewer); any other owner afterwards is foreign.
   */
  isOwner(owner: string): boolean {
    if (this.login === null) {
      this.login = owner;
      return true;
    }
    return this.login === owner;
  }
}
