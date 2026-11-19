import { z } from 'zod';
import { errorResponse } from '../utils/apiResponse.js';

export const loginSchema = z.object({
  email: z
    .string({ required_error: 'Corporate email is required.' })
    .trim()
    .toLowerCase()
    .email({ message: 'Must be a valid corporate email address.' }),
  password: z
    .string({ required_error: 'Password is required.' })
    .min(1, { message: 'Password cannot be blank.' }),
});

export const registerSchema = z.object({
  name: z
    .string({ required_error: 'Full name is required.' })
    .min(2, { message: 'Name must be at least 2 characters.' })
    .trim(),
  email: z
    .string({ required_error: 'Corporate email is required.' })
    .trim()
    .toLowerCase()
    .email({ message: 'Must be a valid corporate email address.' }),
  password: z
    .string({ required_error: 'Password is required.' })
    .min(8, { message: 'Password must be at least 8 characters long.' })
    .regex(/[A-Z]/, { message: 'Password must contain at least 1 uppercase letter.' })
    .regex(/[a-z]/, { message: 'Password must contain at least 1 lowercase letter.' })
    .regex(/\d/, { message: 'Password must contain at least 1 number.' }),
  orgId: z.string().trim().default('org_abc'),
  department: z.string().trim().default('General'),
  role: z
    .enum(['super_admin', 'org_admin', 'hr_admin', 'it_admin', 'manager', 'employee'])
    .default('employee'),
  managerId: z.string().trim().nullable().optional(),
});

export const refreshTokenSchema = z.object({
  refreshToken: z
    .string({ required_error: 'Refresh token is required.' })
    .min(1, { message: 'Refresh token cannot be blank.' }),
});

export const forgotPasswordSchema = z.object({
  email: z
    .string({ required_error: 'Corporate email is required.' })
    .trim()
    .toLowerCase()
    .email({ message: 'Must be a valid corporate email address.' }),
});

/**
 * Higher-order middleware to validate incoming request bodies against a Zod schema
 */
export function validateSchema(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const formattedErrors = result.error.errors.map((err) => ({
        field: err.path.join('.'),
        message: err.message,
      }));

      return errorResponse(res, {
        statusCode: 400,
        message: formattedErrors[0]?.message || 'Input validation failed.',
        error: formattedErrors,
      });
    }

    // Attach validated and sanitized data to req.body
    req.body = result.data;
    next();
  };
}
