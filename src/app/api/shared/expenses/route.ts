import {
  handleSharedExpensesGet,
  handleSharedExpensesPatch,
  handleSharedExpensesPost,
} from '@/modules/shared-ops/expenses/expenses-route.handler';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return handleSharedExpensesGet(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleSharedExpensesPost(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleSharedExpensesPatch(request);
}
