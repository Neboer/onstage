// Isolated API integration harness only; not the public Site entry point.
import { handleApi, Env } from "./handler";
export default { fetch(request: Request, env: Env): Promise<Response> { return handleApi(request, env); } };
