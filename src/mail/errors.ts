/** Thrown for errors that retrying cannot fix (for example, "no such message"). */
export class NotFoundError extends Error {}
/** The credentials are revoked or wrong. Only fixing the credentials helps. */
export class AuthError extends Error {}
