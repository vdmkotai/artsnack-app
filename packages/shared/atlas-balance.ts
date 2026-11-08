type MoneyValue = { value?: string; currency?: string };

export type AtlasBalanceResponse = {
  available?: MoneyValue;
  cash?: MoneyValue;
  bonus?: MoneyValue;
  frozen?: MoneyValue;
};

export type AtlasBalance = {
  available: number | null;
  cash: number | null;
  bonus: number | null;
  frozen: number | null;
  currency: string;
};

/** Atlas returns money as `{value: "125.500000", currency: "usd"}`. */
function amount(money: MoneyValue | undefined): number | null {
  const parsed = Number(money?.value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseAtlasBalance(data: AtlasBalanceResponse): AtlasBalance {
  return {
    available: amount(data.available),
    cash: amount(data.cash),
    bonus: amount(data.bonus),
    frozen: amount(data.frozen),
    currency: data.available?.currency?.toUpperCase() ?? "USD",
  };
}
