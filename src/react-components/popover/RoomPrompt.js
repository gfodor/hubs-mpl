import React from "react";
import styles from "./RoomPrompt.scss";

export function RoomPrompt() {
  return (
    <div className={styles.roomPrompt}>
      <div className={styles.label}>Today's question to answer around the group:</div>

      <div className={styles.question}>
        What is the one thing we should be doing as a community that we are not doing right now, and have not expressed
        any plans of doing?
      </div>

      <div className={styles.tip}>Please organize into rooms of 8 to 12 people.</div>
    </div>
  );
}
