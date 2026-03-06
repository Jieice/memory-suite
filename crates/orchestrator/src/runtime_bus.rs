use api_types::RuntimeEvent;
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct RuntimeBus {
    sender: broadcast::Sender<RuntimeEvent>,
}

impl Default for RuntimeBus {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(256);
        Self { sender }
    }

    pub fn publish(&self, event: RuntimeEvent) {
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RuntimeEvent> {
        self.sender.subscribe()
    }
}
