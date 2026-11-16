import { DomainRuleError } from '@/core/domain';
import { StorageError } from '@/core/ports/storage.port';
import {
  assertCapability,
  AuthError,
  type AuthSessionContext,
  resolveAuthSessionContext,
} from '@/modules/shared-ops/auth';
import { isValidUuid } from '@/modules/shared-ops/auth/auth.contracts';
import { LocationCustodyError } from '@/modules/shared-ops/locations-qr/location-zoning.service';
import { createProductionIntakeVehicleUseCase } from './intake-vehicle.repository';
import {
  type IntakeVehicleInput,
  IntakeVehicleUseCase,
  VehicleIntakeError,
} from './intake-vehicle.use-case';

const ALLOWED_GET_PARAMS = new Set(['view', 'format', 'limit']);

const SECURITY_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
} as const;

export interface SalvageVehiclesRouteDeps {
  readonly resolveSession?: (options?: {
    isMutationContext?: boolean;
  }) => Promise<AuthSessionContext>;
  readonly useCase?: Pick<
    IntakeVehicleUseCase,
    'execute' | 'listVehicles' | 'listHtaSection60Register'
  >;
}

function jsonResponse(
  status: number,
  body: unknown,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
    },
  });
}

function jsonErrorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return jsonResponse(status, {
    error: {
      code,
      message,
    },
  });
}

function handleErrorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof StorageError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof LocationCustodyError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof DomainRuleError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof VehicleIntakeError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  return jsonErrorResponse(
    500,
    'INTERNAL_SERVER_ERROR',
    'Unexpected error processing vehicle intake request.',
  );
}

export async function handleSalvageVehiclesPost(
  request: Request,
  deps: SalvageVehiclesRouteDeps = {},
): Promise<Response> {
  try {
    const resolveSession =
      deps.resolveSession ??
      ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: true });
    assertCapability(session, 'FR-INT-01');

    const rawContentType = request.headers.get('content-type') ?? '';
    const mimeType = rawContentType.split(';')[0]?.trim().toLowerCase();
    if (mimeType !== 'application/json') {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        'POST /api/salvage/vehicles requires Content-Type: application/json.',
      );
    }

    const headerKey = request.headers.get('idempotency-key');
    if (!headerKey || !isValidUuid(headerKey.trim())) {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        'Header "Idempotency-Key" must be a valid UUID string.',
      );
    }
    const normalizedHeaderKey = headerKey.trim().toLowerCase();

    let parsedJson: unknown;
    try {
      parsedJson = await request.json();
    } catch {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        'Malformed JSON request body.',
      );
    }

    if (
      !parsedJson ||
      typeof parsedJson !== 'object' ||
      Array.isArray(parsedJson)
    ) {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        'Request body must be a JSON object.',
      );
    }

    const bodyRecord = parsedJson as Record<string, unknown>;
    if (bodyRecord.idempotencyKey !== undefined) {
      if (
        typeof bodyRecord.idempotencyKey !== 'string' ||
        bodyRecord.idempotencyKey.trim().toLowerCase() !== normalizedHeaderKey
      ) {
        throw new VehicleIntakeError(
          'INVALID_INTAKE_INPUT',
          'Body idempotencyKey must match Idempotency-Key header when provided.',
        );
      }
    }

    const payload = {
      ...bodyRecord,
      idempotencyKey: normalizedHeaderKey,
    } as unknown as IntakeVehicleInput;

    const useCase = deps.useCase ?? createProductionIntakeVehicleUseCase();
    const result = await useCase.execute(session, payload);

    return jsonResponse(result.replayed ? 200 : 201, result);
  } catch (error) {
    return handleErrorResponse(error);
  }
}

export async function handleSalvageVehiclesGet(
  request: Request,
  deps: SalvageVehiclesRouteDeps = {},
): Promise<Response> {
  try {
    const resolveSession =
      deps.resolveSession ??
      ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: false });

    const url = new URL(request.url);
    for (const key of url.searchParams.keys()) {
      if (!ALLOWED_GET_PARAMS.has(key)) {
        throw new VehicleIntakeError(
          'INVALID_INTAKE_INPUT',
          `Unknown query parameter: "${key}".`,
        );
      }
      if (url.searchParams.getAll(key).length > 1) {
        throw new VehicleIntakeError(
          'INVALID_INTAKE_INPUT',
          `Duplicate query parameter: "${key}".`,
        );
      }
    }

    const view = url.searchParams.get('view');
    const rawFormat = url.searchParams.get('format');
    const rawLimit = url.searchParams.get('limit');

    const useCase = deps.useCase ?? createProductionIntakeVehicleUseCase();

    if (view === 'hta-s60-register') {
      if (rawLimit !== null) {
        throw new VehicleIntakeError(
          'INVALID_INTAKE_INPUT',
          'Query parameter "limit" is not supported with view=hta-s60-register.',
        );
      }
      const normalizedFormat = (rawFormat ?? 'json').toLowerCase();
      if (normalizedFormat !== 'json' && normalizedFormat !== 'csv') {
        throw new VehicleIntakeError(
          'INVALID_INTAKE_INPUT',
          `Unsupported format "${rawFormat}". Expected "json" or "csv".`,
        );
      }

      const register = await useCase.listHtaSection60Register(
        session,
        normalizedFormat === 'csv' ? 'CSV' : 'JSON',
      );

      if (register.format === 'CSV') {
        return new Response(register.csvContent, {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${register.filename}"`,
            ...SECURITY_HEADERS,
          },
        });
      }

      return jsonResponse(200, {
        view: 'hta-s60-register',
        count: register.rows.length,
        rows: register.rows,
      });
    }

    if (view !== null) {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        `Unsupported view parameter: "${view}".`,
      );
    }

    if (rawFormat !== null) {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        'Query parameter "format" is only supported with view=hta-s60-register.',
      );
    }

    let limit: number | undefined;
    if (rawLimit !== null) {
      if (!/^\d+$/.test(rawLimit)) {
        throw new VehicleIntakeError(
          'INVALID_INTAKE_INPUT',
          'Query parameter "limit" must be a positive integer.',
        );
      }
      limit = Number.parseInt(rawLimit, 10);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new VehicleIntakeError(
          'INVALID_INTAKE_INPUT',
          'Query parameter "limit" must be between 1 and 200.',
        );
      }
    }

    const listed = await useCase.listVehicles(session, { limit });
    return jsonResponse(200, {
      scope: listed.scope,
      count: listed.vehicles.length,
      vehicles: listed.vehicles,
    });
  } catch (error) {
    return handleErrorResponse(error);
  }
}
