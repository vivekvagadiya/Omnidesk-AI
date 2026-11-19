/**
 * Standardized API response format helper
 */
export function successResponse(res, { data = null, message = 'Success', statusCode = 200 } = {}) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

export function errorResponse(res, { message = 'Internal Server Error', statusCode = 500, error = null } = {}) {
  return res.status(statusCode).json({
    success: false,
    message,
    error: error || undefined,
  });
}
