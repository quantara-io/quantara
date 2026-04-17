export interface CoachSession {
  sessionId: string;
  userId: string;
  summary: string;
  topicTags: string[];
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CoachMessage {
  messageId: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
