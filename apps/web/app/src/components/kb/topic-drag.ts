export const TOPIC_DRAG_TYPE = "application/x-bread-kb-topic"

export type TopicDropEdge = "before" | "after"
export type TopicDropTarget = { id: string; edge: TopicDropEdge }
