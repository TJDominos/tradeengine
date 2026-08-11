use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{broadcast, mpsc};

use crate::planner::{self, AssetDefinition, TradePlanningInput};
use crate::{ApiError, Config, Database, SettingsState, StrategyExecutionTaskAttemptRecord};

const EVENT_BUS_CAPACITY: usize = 1024;
const DIRECTIVE_QUEUE_CAPACITY: usize = 256;
const EXECUTION_QUEUE_CAPACITY: usize = 256;
const DEFAULT_EXECUTION_BATCH_SIZE: usize = 100;

#[derive(Clone)]
pub(crate) struct ActorRuntime {
    event_tx: broadcast::Sender<MarketEvent>,
}

impl ActorRuntime {
    pub(crate) fn publish(&self, event: MarketEvent) {
        if let Err(error) = self.event_tx.send(event) {
            log::warn!("actor event bus has no active receivers for event: {error:?}");
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExternalTradeSide {
    Buy,
    Sell,
}

impl ExternalTradeSide {
    pub(crate) fn from_event_type(value: &str) -> Option<Self> {
        match value.trim().to_lowercase().as_str() {
            "whale_buy" | "buy" | "external_buy" => Some(Self::Buy),
            "whale_sell" | "sell" | "external_sell" => Some(Self::Sell),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StrategyObjective {
    Accumulation,
    Distribution,
    Shakeout,
}

impl StrategyObjective {
    fn from_settings(value: &str) -> Self {
        match value.trim().to_lowercase().as_str() {
            "distribution" => Self::Distribution,
            "shakeout" => Self::Shakeout,
            _ => Self::Accumulation,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Accumulation => "accumulation",
            Self::Distribution => "distribution",
            Self::Shakeout => "shakeout",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct StrategySettings {
    pub(crate) user_id: i64,
    pub(crate) contract_address: String,
    pub(crate) volume_target: f64,
    pub(crate) net_buyin_target: f64,
    pub(crate) objective: StrategyObjective,
    pub(crate) trigger_threshold_usd: f64,
    pub(crate) min_order_size: f64,
    pub(crate) max_order_size: f64,
    pub(crate) absorb_ratio: f64,
    pub(crate) follow_sell_ratio: f64,
    pub(crate) dump_ratio: f64,
}

impl StrategySettings {
    pub(crate) fn from_settings(user_id: i64, settings: &SettingsState) -> Self {
        Self {
            user_id,
            contract_address: settings.contract_address.trim().to_string(),
            volume_target: settings.volume_target.max(0.0),
            net_buyin_target: settings.net_buyin_target,
            objective: StrategyObjective::from_settings(&settings.macro_objective),
            trigger_threshold_usd: settings.trigger_threshold_usd.max(0.0),
            min_order_size: settings.min_order_size.max(0.000001),
            max_order_size: settings
                .max_order_size
                .max(settings.min_order_size)
                .max(0.000001),
            absorb_ratio: settings.absorb_ratio.max(0.0),
            follow_sell_ratio: settings.follow_sell_ratio.max(0.0),
            dump_ratio: settings.dump_ratio.max(0.0),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ExternalTradeEvent {
    pub(crate) user_id: i64,
    pub(crate) event_id: String,
    pub(crate) side: ExternalTradeSide,
    pub(crate) amount_usd: f64,
    pub(crate) contract_address: String,
    pub(crate) wallet_address: Option<String>,
    pub(crate) tx_signature: Option<String>,
    pub(crate) is_loss_cut: bool,
    pub(crate) execute: bool,
    pub(crate) occurred_at: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct OrderFilledEvent {
    pub(crate) user_id: i64,
    pub(crate) run_id: i64,
    pub(crate) task_id: i64,
    pub(crate) plan_version: i64,
    pub(crate) status: String,
    pub(crate) tx_signature: Option<String>,
    pub(crate) error_message: Option<String>,
    pub(crate) filled_at: u64,
}

#[derive(Debug, Clone)]
pub(crate) enum MarketEvent {
    ExternalTrade(ExternalTradeEvent),
    OrderFilled(OrderFilledEvent),
    SettingsUpdated(StrategySettings),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MacroDirective {
    pub(crate) directive_id: String,
    pub(crate) user_id: i64,
    pub(crate) run_id: i64,
    pub(crate) objective: StrategyObjective,
    pub(crate) target_net_pos: f64,
    pub(crate) target_volume: f64,
    pub(crate) min_order_size: f64,
    pub(crate) max_order_size: f64,
    pub(crate) base_asset: AssetDefinition,
    pub(crate) quote_asset: AssetDefinition,
    pub(crate) reason: String,
    pub(crate) execute: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct OrderIntent {
    pub(crate) account_id: String,
    pub(crate) side: planner::OrderSide,
    pub(crate) amount: f64,
    pub(crate) price_limit: Option<f64>,
}

impl From<&planner::OrderIntent> for OrderIntent {
    fn from(intent: &planner::OrderIntent) -> Self {
        Self {
            account_id: intent.account_id.clone(),
            side: intent.side,
            amount: intent.amount,
            price_limit: None,
        }
    }
}

#[derive(Debug, Clone)]
struct PlannerDispatch {
    user_id: i64,
    run_id: i64,
    plan_version: i64,
    intent_count: usize,
    execute: bool,
}

#[derive(Debug, Clone)]
struct ExecutionRequest {
    user_id: i64,
    run_id: i64,
    max_tasks: usize,
}

#[derive(Debug, Default)]
struct StrategyProgress {
    executed_count: usize,
    failed_count: usize,
    last_fill_at: Option<u64>,
}

pub(crate) fn spawn_actor_runtime(db: Arc<Mutex<Database>>, config: Arc<Config>) -> ActorRuntime {
    let (event_tx, _) = broadcast::channel(EVENT_BUS_CAPACITY);
    let (directive_tx, directive_rx) = mpsc::channel(DIRECTIVE_QUEUE_CAPACITY);
    let (execution_tx, execution_rx) = mpsc::channel(EXECUTION_QUEUE_CAPACITY);

    tokio::spawn(run_strategy_engine(
        db.clone(),
        event_tx.subscribe(),
        directive_tx,
    ));
    tokio::spawn(run_planner_actor(db.clone(), directive_rx, execution_tx));
    tokio::spawn(run_execution_gateway(
        db,
        config,
        event_tx.clone(),
        execution_rx,
    ));

    ActorRuntime { event_tx }
}

async fn run_strategy_engine(
    db: Arc<Mutex<Database>>,
    mut event_rx: broadcast::Receiver<MarketEvent>,
    directive_tx: mpsc::Sender<MacroDirective>,
) {
    let mut progress_by_run: HashMap<i64, StrategyProgress> = HashMap::new();

    loop {
        match event_rx.recv().await {
            Ok(MarketEvent::ExternalTrade(event)) => {
                let db = db.clone();
                let event_id = event.event_id.clone();
                let directive = tokio::task::spawn_blocking(move || {
                    let mut db = db.lock().expect("database mutex poisoned");
                    build_directive_for_external_trade(&mut db, &event)
                })
                .await;

                match directive {
                    Ok(Ok(Some(directive))) => {
                        if let Err(error) = directive_tx.send(directive).await {
                            log::warn!("strategy engine could not enqueue directive for {event_id}: {error}");
                        }
                    }
                    Ok(Ok(None)) => {}
                    Ok(Err(error)) => {
                        log::warn!(
                            "strategy engine rejected external event {event_id}: {}",
                            error.message
                        );
                    }
                    Err(error) => {
                        log::error!("strategy engine task join failed for {event_id}: {error}");
                    }
                }
            }
            Ok(MarketEvent::SettingsUpdated(settings)) => {
                let db = db.clone();
                let user_id = settings.user_id;
                let directive = tokio::task::spawn_blocking(move || {
                    let mut db = db.lock().expect("database mutex poisoned");
                    build_directive_for_settings_update(&mut db, &settings)
                })
                .await;

                match directive {
                    Ok(Ok(Some(directive))) => {
                        if let Err(error) = directive_tx.send(directive).await {
                            log::warn!("strategy engine could not enqueue settings directive for user {user_id}: {error}");
                        }
                    }
                    Ok(Ok(None)) => {}
                    Ok(Err(error)) => {
                        log::warn!("strategy settings update for user {user_id} did not produce a directive: {}", error.message);
                    }
                    Err(error) => {
                        log::error!(
                            "strategy settings task join failed for user {user_id}: {error}"
                        );
                    }
                }
            }
            Ok(MarketEvent::OrderFilled(fill)) => {
                let progress = progress_by_run.entry(fill.run_id).or_default();
                if fill.status == "executed" {
                    progress.executed_count += 1;
                } else {
                    progress.failed_count += 1;
                }
                progress.last_fill_at = Some(fill.filled_at);
                log::info!(
                    "strategy progress updated: user={}, run={}, task={}, plan={}, status={}, executed={}, failed={}, tx={:?}, error={:?}",
                    fill.user_id,
                    fill.run_id,
                    fill.task_id,
                    fill.plan_version,
                    fill.status,
                    progress.executed_count,
                    progress.failed_count,
                    fill.tx_signature,
                    fill.error_message,
                );
            }
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                log::warn!("strategy engine lagged and skipped {skipped} market event(s)");
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

async fn run_planner_actor(
    db: Arc<Mutex<Database>>,
    mut directive_rx: mpsc::Receiver<MacroDirective>,
    execution_tx: mpsc::Sender<ExecutionRequest>,
) {
    while let Some(directive) = directive_rx.recv().await {
        let db = db.clone();
        let directive_id = directive.directive_id.clone();
        let dispatch = tokio::task::spawn_blocking(move || {
            let mut db = db.lock().expect("database mutex poisoned");
            persist_macro_directive(&mut db, &directive)
        })
        .await;

        match dispatch {
            Ok(Ok(dispatch)) => {
                log::info!(
                    "planner persisted directive {directive_id}: run={}, version={}, intents={}, execute={}",
                    dispatch.run_id,
                    dispatch.plan_version,
                    dispatch.intent_count,
                    dispatch.execute,
                );
                if dispatch.execute {
                    let request = ExecutionRequest {
                        user_id: dispatch.user_id,
                        run_id: dispatch.run_id,
                        max_tasks: DEFAULT_EXECUTION_BATCH_SIZE,
                    };
                    if let Err(error) = execution_tx.send(request).await {
                        log::warn!("planner could not enqueue execution for directive {directive_id}: {error}");
                    }
                }
            }
            Ok(Err(error)) => {
                log::warn!(
                    "planner failed to persist directive {directive_id}: {}",
                    error.message
                );
            }
            Err(error) => {
                log::error!("planner task join failed for directive {directive_id}: {error}");
            }
        }
    }
}

async fn run_execution_gateway(
    db: Arc<Mutex<Database>>,
    config: Arc<Config>,
    event_tx: broadcast::Sender<MarketEvent>,
    mut execution_rx: mpsc::Receiver<ExecutionRequest>,
) {
    while let Some(request) = execution_rx.recv().await {
        let db = db.clone();
        let config = config.clone();
        let attempts = tokio::task::spawn_blocking(move || {
            let mut db = db.lock().expect("database mutex poisoned");
            db.consume_strategy_execution_tasks(request.run_id, request.max_tasks, &config)
        })
        .await;

        match attempts {
            Ok(Ok(attempts)) => publish_execution_attempts(&event_tx, request.user_id, attempts),
            Ok(Err(error)) => {
                log::warn!(
                    "execution gateway failed for user={}, run={}: {}",
                    request.user_id,
                    request.run_id,
                    error.message,
                );
            }
            Err(error) => {
                log::error!(
                    "execution gateway task join failed for user={}, run={}: {error}",
                    request.user_id,
                    request.run_id,
                );
            }
        }
    }
}

fn publish_execution_attempts(
    event_tx: &broadcast::Sender<MarketEvent>,
    user_id: i64,
    attempts: Vec<StrategyExecutionTaskAttemptRecord>,
) {
    for attempt in attempts {
        let event = MarketEvent::OrderFilled(OrderFilledEvent {
            user_id,
            run_id: attempt.run_id,
            task_id: attempt.task_id,
            plan_version: attempt.plan_version,
            status: attempt.status,
            tx_signature: attempt.tx_signature,
            error_message: attempt.error_message,
            filled_at: attempt.finished_at,
        });
        if let Err(error) = event_tx.send(event) {
            log::warn!("execution gateway could not publish order fill event: {error:?}");
        }
    }
}

pub(crate) fn build_directive_for_external_trade(
    db: &mut Database,
    event: &ExternalTradeEvent,
) -> Result<Option<MacroDirective>, ApiError> {
    let settings =
        StrategySettings::from_settings(event.user_id, &db.load_settings(event.user_id)?);
    if !settings.contract_address.is_empty() && settings.contract_address != event.contract_address
    {
        db.add_strategy_log(
            event.user_id,
            "event_ignored_contract_mismatch",
            &format!(
                "Ignored external trade {} for {}; active contract is {}",
                event.event_id, event.contract_address, settings.contract_address,
            ),
        )?;
        return Ok(None);
    }
    if event.amount_usd < settings.trigger_threshold_usd {
        db.add_strategy_log(
            event.user_id,
            "event_ignored_threshold",
            &format!(
                "Ignored external trade {} amount {:.6}; threshold is {:.6}",
                event.event_id, event.amount_usd, settings.trigger_threshold_usd,
            ),
        )?;
        return Ok(None);
    }

    let Some(run) = db.get_latest_strategy_execution_run(event.user_id)? else {
        db.add_strategy_log(
            event.user_id,
            "event_ignored_no_active_run",
            &format!(
                "Ignored external trade {}; no strategy execution run exists",
                event.event_id
            ),
        )?;
        return Ok(None);
    };

    let target_net_pos = match settings.objective {
        StrategyObjective::Accumulation => match event.side {
            ExternalTradeSide::Sell => event.amount_usd * settings.absorb_ratio,
            ExternalTradeSide::Buy => 0.0,
        },
        StrategyObjective::Distribution => match event.side {
            ExternalTradeSide::Buy => -(event.amount_usd * settings.follow_sell_ratio),
            ExternalTradeSide::Sell => 0.0,
        },
        StrategyObjective::Shakeout => {
            if event.is_loss_cut {
                event.amount_usd
            } else {
                match event.side {
                    ExternalTradeSide::Buy => -(event.amount_usd * settings.dump_ratio),
                    ExternalTradeSide::Sell => 0.0,
                }
            }
        }
    };

    if target_net_pos.abs() < settings.min_order_size {
        db.add_strategy_log(
            event.user_id,
            "event_ignored_order_floor",
            &format!(
                "Ignored external trade {}; computed target {:.6} is below min order {:.6}",
                event.event_id, target_net_pos, settings.min_order_size,
            ),
        )?;
        return Ok(None);
    }

    let directive = MacroDirective {
        directive_id: format!("directive-{}-{}", event.user_id, event.event_id),
        user_id: event.user_id,
        run_id: run.id,
        objective: settings.objective.clone(),
        target_net_pos,
        target_volume: target_net_pos.abs(),
        min_order_size: settings.min_order_size,
        max_order_size: settings.max_order_size,
        base_asset: AssetDefinition {
            symbol: run.base_symbol,
            mint: run.base_mint,
            decimals: run.base_decimals,
        },
        quote_asset: AssetDefinition {
            symbol: run.quote_symbol,
            mint: run.quote_mint,
            decimals: run.quote_decimals,
        },
        reason: format!(
            "External {:?} event {} amount {:.6} adjusted {} target; wallet={:?}; tx={:?}; occurred_at={}",
            event.side,
            event.event_id,
            event.amount_usd,
            settings.objective.as_str(),
            event.wallet_address,
            event.tx_signature,
            event.occurred_at,
        ),
        execute: event.execute,
    };
    db.add_strategy_log(
        event.user_id,
        "event_directive_created",
        &format!(
            "Created directive {} from external event {} with target_net_pos={:.6}, execute={}",
            directive.directive_id, event.event_id, directive.target_net_pos, directive.execute,
        ),
    )?;

    Ok(Some(directive))
}

pub(crate) fn build_directive_for_settings_update(
    db: &mut Database,
    settings: &StrategySettings,
) -> Result<Option<MacroDirective>, ApiError> {
    let Some(run) = db.get_latest_strategy_execution_run(settings.user_id)? else {
        return Ok(None);
    };
    let target_net_pos = settings.net_buyin_target;
    let target_volume = settings.volume_target.max(target_net_pos.abs());
    if target_volume <= 0.0 && target_net_pos == 0.0 {
        return Ok(None);
    }

    Ok(Some(MacroDirective {
        directive_id: format!(
            "settings-directive-{}-{}",
            settings.user_id,
            run.latest_plan_version + 1
        ),
        user_id: settings.user_id,
        run_id: run.id,
        objective: settings.objective.clone(),
        target_net_pos,
        target_volume,
        min_order_size: settings.min_order_size,
        max_order_size: settings.max_order_size,
        base_asset: AssetDefinition {
            symbol: run.base_symbol,
            mint: run.base_mint,
            decimals: run.base_decimals,
        },
        quote_asset: AssetDefinition {
            symbol: run.quote_symbol,
            mint: run.quote_mint,
            decimals: run.quote_decimals,
        },
        reason: format!(
            "Settings changed for {} target_net_pos={:.6}, target_volume={:.6}",
            settings.objective.as_str(),
            target_net_pos,
            target_volume,
        ),
        execute: false,
    }))
}

fn persist_macro_directive(
    db: &mut Database,
    directive: &MacroDirective,
) -> Result<PlannerDispatch, ApiError> {
    let Some(run) = db.get_latest_strategy_execution_run(directive.user_id)? else {
        return Err(crate::bad_request(
            "No strategy execution run found for directive planning",
        ));
    };
    if run.id != directive.run_id {
        return Err(crate::bad_request(
            "Directive run is no longer the latest strategy execution run",
        ));
    }

    let input = directive.to_planning_input();
    let intents = db.generate_trade_plan(directive.user_id, &input)?;
    let _order_intents = intents.iter().map(OrderIntent::from).collect::<Vec<_>>();
    let plan_version = run.latest_plan_version + 1;
    db.replace_strategy_execution_tasks(run.id, plan_version, &intents, "pending")?;
    db.update_strategy_execution_run_status(run.id, plan_version, "replanned")?;
    db.add_strategy_log(
        directive.user_id,
        "actor_replan",
        &format!(
            "Planner re-solved directive {} into {} intent(s) at plan version {}. Reason: {}",
            directive.directive_id,
            intents.len(),
            plan_version,
            directive.reason,
        ),
    )?;

    Ok(PlannerDispatch {
        user_id: directive.user_id,
        run_id: run.id,
        plan_version,
        intent_count: intents.len(),
        execute: directive.execute,
    })
}

impl MacroDirective {
    fn to_planning_input(&self) -> TradePlanningInput {
        let target_buy_volume = self.target_net_pos.max(0.0);
        let target_sell_volume = (-self.target_net_pos).max(0.0);
        let target_total_volume = self
            .target_volume
            .max(target_buy_volume + target_sell_volume)
            .max(self.min_order_size);

        TradePlanningInput {
            target_buy_volume,
            target_sell_volume,
            target_total_volume,
            micro_task_size_hint: self.max_order_size.max(self.min_order_size),
            base_asset: self.base_asset.clone(),
            quote_asset: self.quote_asset.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{strategy, Database, ImportPrivateKeyRequest, TradeRequest};

    #[test]
    fn external_events_map_to_objective_directives() {
        let run_base = AssetDefinition {
            symbol: "SOL".to_string(),
            mint: "So11111111111111111111111111111111111111112".to_string(),
            decimals: 9,
        };
        let run_quote = AssetDefinition {
            symbol: "USDC".to_string(),
            mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string(),
            decimals: 6,
        };
        let directive = MacroDirective {
            directive_id: "test".to_string(),
            user_id: 1,
            run_id: 1,
            objective: StrategyObjective::Shakeout,
            target_net_pos: -30.0,
            target_volume: 30.0,
            min_order_size: 5.0,
            max_order_size: 12.0,
            base_asset: run_base,
            quote_asset: run_quote,
            reason: "test".to_string(),
            execute: false,
        };

        let input = directive.to_planning_input();
        assert_eq!(input.target_buy_volume, 0.0);
        assert_eq!(input.target_sell_volume, 30.0);
        assert_eq!(input.target_total_volume, 30.0);
        assert_eq!(input.micro_task_size_hint, 12.0);
    }

    #[test]
    fn external_sell_event_replans_latest_run_without_live_execution() {
        let temp_dir = std::env::temp_dir();
        let db_path = temp_dir.join(format!("tradeengine-actor-replan-{}.db", crate::now_ts()));

        let mut db = Database::open(db_path.to_str().expect("db path to str")).expect("open db");
        let user = db
            .create_user("actor_admin", "averysecurepassword")
            .expect("create user");
        let encryption_key = [23_u8; 32];
        let generated_keypair = solana_sdk::signature::Keypair::new();
        let private_key = bs58::encode(generated_keypair.to_bytes()).into_string();
        let imported = db
            .import_private_key(
                user.id,
                ImportPrivateKeyRequest {
                    label: "Actor Wallet".to_string(),
                    private_key,
                },
                encryption_key,
            )
            .expect("import managed key");
        db.upsert_account_balance_snapshot(
            imported.id,
            "So11111111111111111111111111111111111111112",
            40.0,
            0.0,
        )
        .expect("seed base balance");
        db.upsert_account_balance_snapshot(
            imported.id,
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            120.0,
            0.0,
        )
        .expect("seed quote balance");

        let initial = strategy::orchestrate_trade(
            &mut db,
            user.id,
            TradeRequest {
                base_symbol: "SOL".to_string(),
                base_mint: "So11111111111111111111111111111111111111112".to_string(),
                base_decimals: 9,
                quote_symbol: "USDC".to_string(),
                quote_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string(),
                quote_decimals: 6,
                target_buy_volume: 10.0,
                target_sell_volume: 0.0,
                target_total_volume: 10.0,
                micro_task_size_hint: Some(10.0),
                confirm_strategy: true,
                confirm_plan: true,
                external_delay_ms: None,
            },
        )
        .expect("start execution");

        let event = ExternalTradeEvent {
            user_id: user.id,
            event_id: "evt-actor-sell".to_string(),
            side: ExternalTradeSide::Sell,
            amount_usd: 18.0,
            contract_address: "So11111111111111111111111111111111111111112".to_string(),
            wallet_address: None,
            tx_signature: None,
            is_loss_cut: false,
            execute: false,
            occurred_at: crate::now_ts(),
        };
        let directive = build_directive_for_external_trade(&mut db, &event)
            .expect("build directive")
            .expect("directive produced");
        assert_eq!(directive.target_net_pos, 18.0);
        assert!(!directive.execute);

        let dispatch = persist_macro_directive(&mut db, &directive).expect("persist directive");
        assert_eq!(dispatch.plan_version, 2);
        assert_eq!(dispatch.run_id, initial.execution_run_id.expect("run id"));
        assert!(dispatch.intent_count > 0);

        let active_run = db
            .get_latest_strategy_execution_run(user.id)
            .expect("load latest run")
            .expect("active run");
        assert_eq!(active_run.latest_plan_version, 2);
        assert_eq!(active_run.status, "replanned");
        let tasks = db
            .list_strategy_execution_tasks(active_run.id)
            .expect("load tasks");
        assert!(tasks
            .iter()
            .any(|task| task.plan_version == 2 && task.side == "Buy"));

        let _ = std::fs::remove_file(db_path);
    }
}
