export interface Event {
  id: number;
  created_at: string;
  source: string;
  type: string;
  subtype: string | null;
  content: string;
}

export interface Subscription {
  consumer_id: string;
  handler_cmd: string;
  filter: string | null;
}

export interface ConsumerProgress {
  consumer_id: string;
  last_acked_id: number;
  updated_at: string;
}

export interface PushPayload {
  source: string;
  type: string;
  subtype?: string | null;
  content: string;
}

export interface ThreadInfo {
  event_count: number;
  subscriptions: Array<Subscription & { last_acked_id: number; updated_at: string | null }>;
}
