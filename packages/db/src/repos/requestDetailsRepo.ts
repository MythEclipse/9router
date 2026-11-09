/**
 * Request-details repository — barrel.
 */

export type { RequestDetail } from "./requestDetailsConfig.ts"
export type { RequestDetailsFilter, RequestDetailsPage } from "./requestDetailsRead.ts"
export {
	getDistinctProviders,
	getRequestDetailById,
	getRequestDetails,
} from "./requestDetailsRead.ts"
export { __test__, saveRequestDetail } from "./requestDetailsWrite.ts"
