import { QODER_CN_CONFIG } from "../constants/oauth.ts";
import { createQoderProvider } from "./qoder.ts";

// Qoder CN (qoder.com.cn) - same device flow as intl Qoder, CN endpoints.
export default createQoderProvider(QODER_CN_CONFIG);
