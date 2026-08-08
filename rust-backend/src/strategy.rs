use serde::Serialize;

use crate::planner::{AssetDefinition, OrderIntent, TradePlanningInput};
use crate::{ApiError, Database, TradeRequest, bad_request};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyExecutionLogEntry {
    pub stage: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyOrchestrationResponse {
    pub strategy_confirmed: bool,
    pub plan_confirmed: bool,
    pub execution_started: bool,
    pub requires_confirmation_step: u8,
    pub execution_run_id: Option<i64>,
    pub plan_version: i64,
    pub planning_input: StrategyPlanningPreview,
    pub planned_intents: Vec<OrderIntentView>,
    pub execution_log: Vec<StrategyExecutionLogEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyPlanningPreview {
    pub base_asset: StrategyAssetView,
    pub quote_asset: StrategyAssetView,
    pub target_buy_volume: f64,
    pub target_sell_volume: f64,
    pub target_total_volume: f64,
    pub micro_task_size_hint: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyAssetView {
    pub symbol: String,
    pub mint: String,
    pub decimals: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderIntentView {
    pub intent_id: String,
    pub intent_type: String,
    pub side: String,
    pub amount: f64,
    pub account_id: String,
    pub paired_account_id: Option<String>,
    pub notes: String,
}

fn build_planning_input(request: &TradeRequest) -> Result<TradePlanningInput, ApiError> {
    let micro_task_size_hint = request.micro_task_size_hint.unwrap_or(25.0);
    if micro_task_size_hint <= 0.0 {
        return Err(bad_request("microTaskSizeHint must be greater than zero"));
    }

    Ok(TradePlanningInput {
        target_buy_volume: request.target_buy_volume,
        target_sell_volume: request.target_sell_volume,
        target_total_volume: request.target_total_volume,
        micro_task_size_hint,
        base_asset: AssetDefinition {
            symbol: request.base_symbol.trim().to_string(),
            mint: request.base_mint.trim().to_string(),
            decimals: request.base_decimals,
        },
        quote_asset: AssetDefinition {
            symbol: request.quote_symbol.trim().to_string(),
            mint: request.quote_mint.trim().to_string(),
            decimals: request.quote_decimals,
        },
    })
}

fn map_order_intent(intent: OrderIntent) -> OrderIntentView {
    OrderIntentView {
        intent_id: intent.intent_id,
        intent_type: format!("{:?}", intent.intent_type),
        side: format!("{:?}", intent.side),
        amount: intent.amount,
        account_id: intent.account_id,
        paired_account_id: intent.paired_account_id,
        notes: intent.notes,
    }
}

fn summarize_intents(intents: &[OrderIntentView]) -> String {
    let total: f64 = intents.iter().map(|intent| intent.amount).sum();
    format!(
        "planned {} intent(s) with total notional {:.4}",
        intents.len(),
        total,
    )
}

pub fn orchestrate_trade(
    db: &mut Database,
    user_id: i64,
    request: TradeRequest,
) -> Result<StrategyOrchestrationResponse, ApiError> {
    let planning_input = build_planning_input(&request)?;
    let preview = StrategyPlanningPreview {
        base_asset: StrategyAssetView {
            symbol: planning_input.base_asset.symbol.clone(),
            mint: planning_input.base_asset.mint.clone(),
            decimals: planning_input.base_asset.decimals,
        },
        quote_asset: StrategyAssetView {
            symbol: planning_input.quote_asset.symbol.clone(),
            mint: planning_input.quote_asset.mint.clone(),
            decimals: planning_input.quote_asset.decimals,
        },
        target_buy_volume: planning_input.target_buy_volume,
        target_sell_volume: planning_input.target_sell_volume,
        target_total_volume: planning_input.target_total_volume,
        micro_task_size_hint: planning_input.micro_task_size_hint,
    };

    let mut execution_log = Vec::new();

    if !request.confirm_strategy {
        execution_log.push(StrategyExecutionLogEntry {
            stage: "strategy_review".to_string(),
            message: "Strategy parameters received. Confirm strategy to generate a planner preview.".to_string(),
        });
        return Ok(StrategyOrchestrationResponse {
            strategy_confirmed: false,
            plan_confirmed: false,
            execution_started: false,
            requires_confirmation_step: 1,
            execution_run_id: None,
            plan_version: 0,
            planning_input: preview,
            planned_intents: Vec::new(),
            execution_log,
        });
    }

    let initial_plan = db.generate_trade_plan(user_id, &planning_input)?;
    let planned_intents = initial_plan.into_iter().map(map_order_intent).collect::<Vec<_>>();
    let plan_summary = summarize_intents(&planned_intents);
    db.add_strategy_log(user_id, "strategy_confirmed", &format!(
        "Strategy confirmed for {}/{} with mints {}/{} and targets buy={}, sell={}, total={}",
        preview.base_asset.symbol,
        preview.quote_asset.symbol,
        preview.base_asset.mint,
        preview.quote_asset.mint,
        preview.target_buy_volume,
        preview.target_sell_volume,
        preview.target_total_volume,
    ))?;
    db.add_strategy_log(user_id, "plan_preview", &plan_summary)?;

    execution_log.push(StrategyExecutionLogEntry {
        stage: "strategy_confirmed".to_string(),
        message: "Strategy confirmed. Planner pre-generated the execution intent queue.".to_string(),
    });
    execution_log.push(StrategyExecutionLogEntry {
        stage: "plan_preview".to_string(),
        message: plan_summary,
    });

    if !request.confirm_plan {
        execution_log.push(StrategyExecutionLogEntry {
            stage: "plan_review".to_string(),
            message: "Confirm the planner result to start execution.".to_string(),
        });
        return Ok(StrategyOrchestrationResponse {
            strategy_confirmed: true,
            plan_confirmed: false,
            execution_started: false,
            requires_confirmation_step: 2,
            execution_run_id: None,
            plan_version: 1,
            planning_input: preview,
            planned_intents,
            execution_log,
        });
    }

    let confirmed_plan = db.generate_trade_plan(user_id, &planning_input)?;
    let run_id = db.create_strategy_execution_run(user_id, &planning_input)?;
    db.replace_strategy_execution_tasks(run_id, 1, &confirmed_plan, "pending")?;
    db.update_strategy_execution_run_status(run_id, 1, "executing")?;
    db.add_strategy_log(user_id, "execution_start", "Execution confirmation received. Starting planner-driven execution orchestration.")?;
    execution_log.push(StrategyExecutionLogEntry {
        stage: "execution_start".to_string(),
        message: "Execution confirmed. Runtime will re-plan before dispatch when external timing drift is observed.".to_string(),
    });

    if let Some(external_delay_ms) = request.external_delay_ms {
        if external_delay_ms > 0 {
            let refreshed_plan = db.generate_trade_plan(user_id, &planning_input)?;
            let next_plan_version = 2;
            db.replace_strategy_execution_tasks(run_id, next_plan_version, &refreshed_plan, "pending")?;
            db.update_strategy_execution_run_status(run_id, next_plan_version, "replanned")?;
            let refreshed_summary = summarize_intents(
                &refreshed_plan.clone().into_iter().map(map_order_intent).collect::<Vec<_>>(),
            );
            db.add_strategy_log(
                user_id,
                "replan_due_to_external_timing",
                &format!(
                    "Detected external delay of {} ms. Re-generated planner queue before execution: {}",
                    external_delay_ms,
                    refreshed_summary,
                ),
            )?;
            execution_log.push(StrategyExecutionLogEntry {
                stage: "replan_due_to_external_timing".to_string(),
                message: format!(
                    "External timing shift detected ({} ms). Planner refreshed the queue before execution.",
                    external_delay_ms,
                ),
            });
            return Ok(StrategyOrchestrationResponse {
                strategy_confirmed: true,
                plan_confirmed: true,
                execution_started: true,
                requires_confirmation_step: 0,
                execution_run_id: Some(run_id),
                plan_version: next_plan_version,
                planning_input: preview,
                planned_intents: refreshed_plan.into_iter().map(map_order_intent).collect(),
                execution_log,
            });
        }
    }

    Ok(StrategyOrchestrationResponse {
        strategy_confirmed: true,
        plan_confirmed: true,
        execution_started: true,
        requires_confirmation_step: 0,
        execution_run_id: Some(run_id),
        plan_version: 1,
        planning_input: preview,
        planned_intents: confirmed_plan.into_iter().map(map_order_intent).collect(),
        execution_log,
    })
}
