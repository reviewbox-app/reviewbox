//! Observable transport timing, never an estimate of model reasoning time.
use super::*;

#[derive(Default)]
pub(super) struct ActivityTiming {
    first_event_ms: Option<u64>,
    active: HashSet<String>,
    interval_start: Option<u64>,
    terminal_ms: u64,
    commands: usize,
}
impl ActivityTiming {
    pub(super) fn observe(&mut self, event: &AgentEvent, elapsed: u64) {
        self.first_event_ms.get_or_insert(elapsed);
        if let Some(AgentProgress::Activity {
            id,
            category:
                AgentActivityKind::Command
                | AgentActivityKind::Read
                | AgentActivityKind::Search
                | AgentActivityKind::ListFiles,
            status,
        }) = &event.progress
        {
            match status {
                AgentActivityStatus::InProgress => {
                    if self.active.insert(id.clone()) {
                        self.commands += 1;
                        self.interval_start.get_or_insert(elapsed);
                    }
                }
                _ => {
                    self.active.remove(id);
                    if self.active.is_empty()
                        && let Some(start) = self.interval_start.take()
                    {
                        self.terminal_ms += elapsed.saturating_sub(start);
                    }
                }
            }
        }
    }
    pub(super) fn value(&self, elapsed: u64) -> Value {
        json!({"firstEventMs":self.first_event_ms,"terminalObservedMs":self.terminal_ms + self.interval_start.map_or(0, |start| elapsed.saturating_sub(start)),"terminalCommands":self.commands})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlapping_commands_are_not_double_counted() {
        let mut timing = ActivityTiming::default();
        let event = |id: &str, status| AgentEvent {
            run_id: "r".into(),
            batch_id: None,
            sequence: 0,
            kind: "progress".into(),
            text: String::new(),
            progress: Some(AgentProgress::Activity {
                id: id.into(),
                category: AgentActivityKind::Command,
                status,
            }),
        };
        timing.observe(&event("a", AgentActivityStatus::InProgress), 10);
        timing.observe(&event("b", AgentActivityStatus::InProgress), 20);
        timing.observe(&event("a", AgentActivityStatus::Completed), 40);
        timing.observe(&event("b", AgentActivityStatus::Completed), 60);
        assert_eq!(
            timing.value(90),
            json!({"firstEventMs":10,"terminalObservedMs":50,"terminalCommands":2})
        );
    }
}
