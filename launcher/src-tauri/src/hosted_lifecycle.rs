//! Native session bookkeeping. Writable construction requires session permission
//! and exclusive GUI ownership in the inherited-pipe adapter.
use crate::lifecycle::{CommandGuard, Lifecycle};
use serde::Serialize;
use std::collections::VecDeque;

const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
const MAX_OUTCOMES: usize = 16;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOutcome {
    request_id: u64,
    command: String,
    returned: bool,
    handler_ok: Option<bool>,
}

struct Active<'a> {
    id: u64,
    command: String,
    _guard: CommandGuard<'a>,
}

pub struct HostedSession<'a> {
    lifecycle: &'a Lifecycle,
    session: String,
    sequence: u64,
    previous_request: u64,
    active: Option<Active<'a>>,
    workflow: Option<u32>,
    draining: bool,
    allow_workflows: bool,
    outcomes: VecDeque<NativeOutcome>,
}

impl<'a> HostedSession<'a> {
    pub fn writable(lifecycle: &'a Lifecycle, session: &str) -> Result<Self, &'static str> {
        let mut state = Self::read_only(lifecycle, session)?;
        state.allow_workflows = true;
        Ok(state)
    }

    pub fn has_workflow(&self) -> bool {
        self.workflow.is_some()
    }
    pub fn read_only(lifecycle: &'a Lifecycle, session: &str) -> Result<Self, &'static str> {
        if session.len() != 64 || !session.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid native hosted session identity");
        }
        Ok(Self {
            lifecycle,
            session: session.to_owned(),
            sequence: 0,
            previous_request: 0,
            active: None,
            workflow: None,
            draining: false,
            allow_workflows: false,
            outcomes: VecDeque::new(),
        })
    }

    fn advance(&mut self) -> Result<(), &'static str> {
        if self.sequence == MAX_SEQUENCE {
            self.draining = true;
            return Err("Hosted lifecycle sequence exhausted");
        }
        self.sequence += 1;
        Ok(())
    }

    pub fn begin_command(&mut self, id: u64, command: &str) -> Result<(), &'static str> {
        if self.draining || self.active.is_some() {
            return Err("Hosted session is draining or another command is active");
        }
        if id <= self.previous_request
            || id > MAX_SEQUENCE
            || command.len() > 128
            || command.is_empty()
            || !command
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_')
        {
            return Err("Invalid or replayed hosted command identity");
        }
        self.advance()?;
        let guard = self.lifecycle.command()?;
        self.previous_request = id;
        self.active = Some(Active {
            id,
            command: command.to_owned(),
            _guard: guard,
        });
        Ok(())
    }

    pub fn begin_workflow(&mut self) -> Result<u32, &'static str> {
        if !self.allow_workflows
            || self.draining
            || self.workflow.is_some()
            || self.active.as_ref().map(|a| a.command.as_str()) != Some("begin_ui_operation")
        {
            return Err("This session cannot start a writable UI workflow");
        }
        let id = self.lifecycle.begin_workflow()?;
        self.workflow = Some(id);
        Ok(id)
    }

    pub fn finish_workflow(&mut self, id: u32) -> Result<(), &'static str> {
        if self.workflow != Some(id)
            || self.draining
            || self.active.as_ref().map(|a| a.command.as_str()) != Some("finish_ui_operation")
        {
            return Err("Workflow receipt is not owned by this active session");
        }
        self.lifecycle.finish_workflow(id)?;
        self.workflow = None;
        Ok(())
    }

    fn record(&mut self, active: Active<'a>, handler_ok: Option<bool>) {
        if self.outcomes.len() == MAX_OUTCOMES {
            self.outcomes.pop_front();
        }
        self.outcomes.push_back(NativeOutcome {
            request_id: active.id,
            command: active.command,
            returned: handler_ok.is_some(),
            handler_ok,
        });
        // Dropping the native command guard happens after recording its return.
    }

    pub fn complete_command(&mut self, handler_ok: bool) -> Result<(), &'static str> {
        let active = self
            .active
            .take()
            .ok_or("No accepted hosted command to complete")?;
        self.record(active, Some(handler_ok));
        let advanced = self.advance();
        self.release_if_drained()?;
        advanced
    }

    fn release_if_drained(&mut self) -> Result<(), &'static str> {
        if self.draining && self.active.is_none() {
            if let Some(id) = self.workflow {
                self.lifecycle.finish_workflow(id)?;
                self.workflow = None;
            }
        }
        Ok(())
    }

    pub fn disconnect(&mut self) -> Result<bool, &'static str> {
        self.draining = true;
        let advanced = self.advance();
        self.release_if_drained()?;
        advanced?;
        Ok(self.active.is_none() && self.workflow.is_none())
    }

    pub fn event(&self) -> Result<Vec<u8>, &'static str> {
        let state = if self.draining {
            "draining"
        } else if self.active.is_some() || self.workflow.is_some() {
            "busy"
        } else {
            "idle"
        };
        let frame = serde_json::json!({
            "type": "event", "name": "creator-mcp-lifecycle", "session": self.session,
            "payload": { "revision": 1, "sequence": self.sequence, "state": state,
                "workflowActive": self.workflow.is_some(), "commandsInFlight": u32::from(self.active.is_some()) }
        });
        let mut bytes = serde_json::to_vec(&frame).map_err(|_| "Cannot encode lifecycle event")?;
        bytes.push(b'\n');
        if bytes.len() > 512 {
            return Err("Lifecycle event exceeds its byte limit");
        }
        Ok(bytes)
    }
}

impl Drop for HostedSession<'_> {
    fn drop(&mut self) {
        self.draining = true;
        if let Some(active) = self.active.take() {
            // Synchronous handler unwinding is not a successful return or rollback.
            self.record(active, None);
        }
        let _ = self.release_if_drained();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn writable_fixture(life: &Lifecycle) -> HostedSession<'_> {
        let mut session = HostedSession::read_only(life, &"a".repeat(64)).unwrap();
        session.allow_workflows = true;
        session
    }
    fn begin(session: &mut HostedSession<'_>) -> u32 {
        session.begin_command(1, "begin_ui_operation").unwrap();
        let receipt = session.begin_workflow().unwrap();
        session.complete_command(true).unwrap();
        receipt
    }

    #[test]
    fn workflow_holds_close_across_command_gaps_and_rejects_foreign_receipts() {
        let life = Lifecycle::new();
        let mut first = writable_fixture(&life);
        let receipt = begin(&mut first);
        assert!(!life.request_close());
        let mut other = HostedSession::read_only(&life, &"b".repeat(64)).unwrap();
        other.begin_command(1, "finish_ui_operation").unwrap();
        assert!(other.finish_workflow(receipt).is_err());
        other.complete_command(false).unwrap();
        other.disconnect().unwrap();
        assert!(!life.request_close());
        first.begin_command(2, "finish_ui_operation").unwrap();
        assert!(first.finish_workflow(receipt + 1).is_err());
        first.finish_workflow(receipt).unwrap();
        assert!(!life.request_close());
        first.complete_command(true).unwrap();
        assert!(life.request_close());
    }

    #[test]
    fn disconnect_between_commands_releases_only_its_owned_gui_workflow() {
        let life = Lifecycle::new();
        let mut session = writable_fixture(&life);
        begin(&mut session);
        assert!(session.disconnect().unwrap());
        assert!(session.begin_command(2, "save_config").is_err());
        assert!(life.request_close());
    }

    #[test]
    fn disconnect_drains_accepted_work_and_records_failure_without_replay() {
        let life = Lifecycle::new();
        let mut session = writable_fixture(&life);
        begin(&mut session);
        session.begin_command(2, "save_config").unwrap();
        assert!(!session.disconnect().unwrap());
        assert!(!life.request_close());
        assert!(session.begin_command(3, "save_config").is_err());
        session.complete_command(false).unwrap();
        assert_eq!(session.outcomes.back().unwrap().handler_ok, Some(false));
        assert!(session.complete_command(true).is_err());
        assert!(session.begin_command(2, "save_config").is_err());
        assert!(life.request_close());
    }

    #[test]
    fn drop_releases_its_own_synchronous_workflow_without_stopping_other_guards() {
        let life = Lifecycle::new();
        let unrelated = life.command().unwrap();
        let mut session = writable_fixture(&life);
        begin(&mut session);
        session.begin_command(2, "save_config").unwrap();
        drop(session);
        assert!(!life.request_close());
        drop(unrelated);
        assert!(life.request_close());
    }

    #[test]
    fn read_only_cannot_gain_workflow_authority_and_events_are_bounded() {
        let life = Lifecycle::new();
        let mut session = HostedSession::read_only(&life, &"f".repeat(64)).unwrap();
        let initial: serde_json::Value = serde_json::from_slice(&session.event().unwrap()).unwrap();
        session.begin_command(1, "begin_ui_operation").unwrap();
        assert!(session.begin_workflow().is_err());
        let busy: serde_json::Value = serde_json::from_slice(&session.event().unwrap()).unwrap();
        assert_eq!(busy["type"], "event");
        assert_eq!(busy["name"], "creator-mcp-lifecycle");
        assert_eq!(busy["payload"]["state"], "busy");
        assert_eq!(busy["payload"]["revision"], 1);
        assert!(busy["payload"]["sequence"].as_u64() > initial["payload"]["sequence"].as_u64());
        session.complete_command(false).unwrap();
        assert!(session.event().unwrap().len() <= 512);
        for id in 2..40 {
            session.begin_command(id, "get_hosted_snapshot").unwrap();
            session.complete_command(true).unwrap();
        }
        assert_eq!(session.outcomes.len(), MAX_OUTCOMES);
        assert_eq!(session.outcomes.back().unwrap().request_id, 39);
        assert!(session.begin_command(39, "get_hosted_snapshot").is_err());
    }
}
