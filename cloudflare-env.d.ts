declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    BUCKET?: R2Bucket;
    ONSTAGE_PUBLIC_ORIGIN?: string;
    ONSTAGE_VERSION?: string;
    ONSTAGE_OPERATOR_TOKEN?: string;
    ONSTAGE_WRITE_FROZEN?: string;
  }
}
