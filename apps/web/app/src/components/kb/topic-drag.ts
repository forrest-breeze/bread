export const TOPIC_DRAG_TYPE = "application/x-breezify-kb-topic"

export type TopicDropEdge = "before" | "after"
export type TopicDropTarget = { id: string; edge: TopicDropEdge }
