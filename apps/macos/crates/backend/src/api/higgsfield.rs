//! `packages/backend/convex/higgsfield.ts` and `higgsfieldProcessor.ts`: the
//! plan's credits and the vendor's own price quotes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Action, NoArgs, Query};

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldAccount {
    pub credits: f64,
    pub plan_type: Option<String>,
}

pub const ACCOUNT: Query<NoArgs, Option<HiggsfieldAccount>> = Query::new("higgsfield:getAccount");

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CachedCost {
    pub signature: String,
    pub credits: f64,
}

/// Every quote fetched so far, by configuration signature.
pub const COSTS: Query<NoArgs, Vec<CachedCost>> = Query::new("higgsfield:listCosts");

#[derive(Clone, Debug, Default, Serialize)]
pub struct RefreshBalanceArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
}

/// Re-reads the credits from the vendor (cached a few minutes server-side).
pub const REFRESH_BALANCE: Action<RefreshBalanceArgs, ()> =
    Action::new("higgsfieldProcessor:refreshBalance");

/// Asks the vendor for one configuration's price; the answer lands in
/// [`COSTS`]. The arguments come ready-made from the composer's rules.
pub const ESTIMATE_COST: Action<Value, Value> = Action::new("higgsfieldProcessor:estimateCost");
