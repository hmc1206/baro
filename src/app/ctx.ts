// 훅끼리 주고받는 공통 타입
import type { Dispatch, SetStateAction } from "react";

export type Setter<T> = Dispatch<SetStateAction<T>>;
// 입력칸 (메모 화면에서는 여러 줄 입력칸 textarea)
export type InputRef = { current: (HTMLInputElement & HTMLTextAreaElement) | null };
