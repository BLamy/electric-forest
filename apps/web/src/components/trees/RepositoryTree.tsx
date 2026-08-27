import { useEffect, useMemo, useRef } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { FsTree } from "@eforest/streamfs";

const pierreTreeLayoutRepair = `
  [data-truncate-grid] {
    align-items: center;
    min-height: var(--trees-row-height);
  }

  [data-truncate-content="visible"] {
    align-items: center;
    display: flex;
    height: var(--trees-row-height);
  }

  [data-truncate-content="overflow"] {
    inset: 0;
    margin: 0;
    position: absolute;
  }
`;

function canonicalPaths(tree: FsTree): readonly string[] {
  const directories = Object.keys(tree.dirs)
    .filter(Boolean)
    .map((path) => (path.endsWith("/") ? path : `${path}/`));
  const files = Object.keys(tree.files);
  return [...directories, ...files].sort((left, right) => left.localeCompare(right));
}

export function RepositoryTree(props: {
  readonly tree: FsTree;
  readonly title?: string;
  readonly selectedPath?: string;
  readonly onOpen: (path: string, kind: "directory" | "file") => void;
  readonly className?: string;
}): React.JSX.Element {
  const paths = useMemo(() => canonicalPaths(props.tree), [props.tree]);
  const files = useMemo(() => Object.keys(props.tree.files), [props.tree.files]);
  return (
    <PierrePathTree
      paths={paths}
      filePaths={files}
      title={props.title}
      selectedPath={props.selectedPath}
      onOpen={props.onOpen}
      className={props.className}
    />
  );
}

export function PierrePathTree(props: {
  readonly paths: readonly string[];
  readonly filePaths?: readonly string[];
  readonly density?: "compact" | "default" | "relaxed";
  readonly title?: string;
  readonly selectedPath?: string;
  readonly onOpen: (path: string, kind: "directory" | "file") => void;
  readonly className?: string;
}): React.JSX.Element {
  const paths = props.paths;
  const signature = paths.join("\n");
  const pathsRef = useRef(paths);
  const filesRef = useRef(new Set(props.filePaths ?? paths));
  const onOpenRef = useRef(props.onOpen);
  pathsRef.current = paths;
  filesRef.current = new Set(props.filePaths ?? paths);
  onOpenRef.current = props.onOpen;

  const { model } = useFileTree({
    density: props.density ?? "default",
    flattenEmptyDirectories: false,
    icons: "minimal",
    initialExpansion: "open",
    initialSelectedPaths: props.selectedPath === undefined ? [] : [props.selectedPath],
    paths,
    search: true,
    unsafeCSS: pierreTreeLayoutRepair,
    onSelectionChange: (selected) => {
      const selectedPath = selected.at(-1);
      if (selectedPath === undefined) return;
      const normalized = selectedPath.replace(/\/$/, "");
      onOpenRef.current(normalized, filesRef.current.has(normalized) ? "file" : "directory");
    },
  });

  useEffect(() => {
    model.resetPaths(pathsRef.current);
  }, [model, signature]);

  return (
    <div
      className={`pierre-tree ${props.className ?? ""}`.trim()}
      data-tree-adapter="@pierre/trees"
      data-tree-density={props.density ?? "default"}
      data-tree-icons="minimal"
      data-tree-layout-repair="overflow-measure-overlay"
      data-testid="pierre-tree"
    >
      <FileTree
        model={model}
        header={props.title === undefined ? undefined : <strong>{props.title}</strong>}
        aria-label={props.title ?? "Repository files"}
        style={{
          height: "min(620px, calc(100vh - 310px))",
          minHeight: "280px",
          width: "100%",
        }}
      />
    </div>
  );
}
