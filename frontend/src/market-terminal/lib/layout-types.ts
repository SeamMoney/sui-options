import type { TabType } from "./tabs";
import type { ChartState } from "./chart-state";

export interface LayoutComponent {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  linkChannel: number | null;
  config: Record<string, unknown>;
}

export interface TabLayout {
  columns: number;
  rowHeight: number;
  zoom?: number;
  components: LayoutComponent[];
}

export interface TabState {
  id: string;
  title: string;
  type: TabType;
  locked: boolean;
  linkChannel: number | null;
  layout: TabLayout;
  /** Serialized chart config — only present in .diq files, not kept in memory at runtime */
  chartState?: ChartState;
}

export interface WorkspaceFile {
  version: number;
  lastModified: string;
  global: {
    activeTabId: string;
  };
  tabs: TabState[];
}
