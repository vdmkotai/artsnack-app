import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { MediaLightbox, type LightboxMedia } from "@/components/media-lightbox";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

function installDomStubs() {
  const focusedElement = { focus() {} };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      activeElement: focusedElement,
      body: { style: { overflow: "" } },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {},
    },
  });
}

function restoreDomStubs() {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: originalDocument,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
}

function image(url: string): LightboxMedia {
  return { url, type: "image" };
}

function previousButton(root: ReactTestInstance) {
  return root
    .findAllByType("button")
    .find((button) =>
      button
        .findAllByType("span")
        .some((label) => label.children.length === 1 && label.children[0] === "Previous"),
    );
}

test("keeps the opened result selected when a newer generation is prepended", () => {
  installDomStubs();
  let renderer: ReactTestRenderer | null = null;
  try {
    const originalItems = [
      image("https://media.test/opened.webp"),
      image("https://media.test/older.webp"),
    ];

    act(() => {
      renderer = create(
        <MediaLightbox items={originalItems} initialIndex={0} isOpen={false} onClose={() => {}} />,
      );
    });
    act(() => {
      renderer?.update(
        <MediaLightbox items={originalItems} initialIndex={0} isOpen onClose={() => {}} />,
      );
    });
    assert.ok(renderer);
    const lightbox = renderer as ReactTestRenderer;

    assert.equal(lightbox.root.findByType("img").props.src, "https://media.test/opened.webp");

    act(() => {
      lightbox.update(
        <MediaLightbox
          items={[image("https://media.test/new.webp"), ...originalItems]}
          initialIndex={0}
          isOpen
          onClose={() => {}}
        />,
      );
    });

    assert.equal(lightbox.root.findByType("img").props.src, "https://media.test/opened.webp");

    const previous = previousButton(lightbox.root);
    assert.ok(previous);
    act(() => previous.props.onClick());
    assert.equal(lightbox.root.findByType("img").props.src, "https://media.test/new.webp");
  } finally {
    act(() => renderer?.unmount());
    restoreDomStubs();
  }
});

test("a reference view yields keyboard and scroll ownership, then returns to the same result", () => {
  installDomStubs();
  let renderer: ReactTestRenderer | null = null;
  let keydown: ((event: { key: string }) => void) | undefined;
  let closes = 0;
  window.addEventListener = ((_name: string, callback: typeof keydown) => {
    keydown = callback;
  }) as typeof window.addEventListener;
  window.removeEventListener = (() => {
    keydown = undefined;
  }) as typeof window.removeEventListener;
  const original = [image("first.png"), image("second.png")];
  const props = {
    initialIndex: 0,
    isOpen: true,
    onClose: () => {
      closes++;
    },
  };
  try {
    act(() => {
      renderer = create(<MediaLightbox {...props} items={original} />);
    });
    const view = renderer! as ReactTestRenderer;
    act(() => keydown?.({ key: "ArrowRight" }));
    assert.equal(view.root.findByType("img").props.src, "second.png");
    act(() => view.update(<MediaLightbox {...props} items={original} suspended />));
    assert.equal(view.toJSON(), null);
    assert.equal(document.body.style.overflow, "");
    act(() => keydown?.({ key: "Escape" }));
    assert.equal(closes, 0);
    const updated = [image("new.png"), ...original];
    act(() => view.update(<MediaLightbox {...props} items={updated} />));
    assert.equal(view.root.findByType("img").props.src, "second.png");
    assert.equal(document.body.style.overflow, "hidden");
    act(() => keydown?.({ key: "Escape" }));
    assert.equal(closes, 1);
  } finally {
    act(() => renderer?.unmount());
    restoreDomStubs();
  }
});

function shownImage(root: ReactTestInstance) {
  const img = root.findByType("img");
  return {
    src: img.props.src as string,
    hidden: String(img.props.className).includes("opacity-0"),
    spinner:
      root.findAll((node) => String(node.props.className ?? "").includes("animate-spin")).length >
      0,
  };
}

function nextButton(root: ReactTestInstance) {
  return root
    .findAllByType("button")
    .find((button) =>
      button
        .findAllByType("span")
        .some((label) => label.children.length === 1 && label.children[0] === "Next"),
    );
}

test("an image that has loaded stays on screen when results are prepended", () => {
  installDomStubs();
  let renderer: ReactTestRenderer | null = null;
  try {
    const items = ["a", "b", "c", "d", "e"].map(image);
    const props = { initialIndex: 4, onClose: () => {} };
    act(() => {
      renderer = create(<MediaLightbox {...props} items={items} isOpen={false} />);
    });
    const view = renderer! as ReactTestRenderer;
    act(() => view.update(<MediaLightbox {...props} items={items} isOpen />));
    assert.deepEqual(shownImage(view.root), { src: "e", hidden: true, spinner: true });
    act(() => view.root.findByType("img").props.onLoad());
    assert.deepEqual(shownImage(view.root), { src: "e", hidden: false, spinner: false });

    // A batch of four finishing: the open image moves from index 4 to 8. Its
    // `src` does not change, so no second `load` event will ever arrive — the
    // image has to stay shown on the strength of the first one.
    const grown = [...["n1", "n2", "n3", "n4"].map(image), ...items];
    act(() => view.update(<MediaLightbox {...props} items={grown} isOpen />));
    assert.deepEqual(shownImage(view.root), { src: "e", hidden: false, spinner: false });

    // And the new results are reachable to the left of the old first one.
    const previous = previousButton(view.root)!;
    for (let step = 0; step < 5; step++) act(() => previous.props.onClick());
    assert.equal(shownImage(view.root).src, "n4");
  } finally {
    act(() => renderer?.unmount());
    restoreDomStubs();
  }
});

test("a deleted item's replacement is pinned too, and the item is followed if it returns", () => {
  installDomStubs();
  let renderer: ReactTestRenderer | null = null;
  try {
    const props = { initialIndex: 1, onClose: () => {} };
    const items = ["a", "b", "c"].map(image);
    act(() => {
      renderer = create(<MediaLightbox {...props} items={items} isOpen={false} />);
    });
    const view = renderer! as ReactTestRenderer;
    act(() => view.update(<MediaLightbox {...props} items={items} isOpen />));
    assert.equal(shownImage(view.root).src, "b");

    // Gone: the neighbour that slid into its place is shown...
    act(() => view.update(<MediaLightbox {...props} items={["a", "c"].map(image)} isOpen />));
    assert.equal(shownImage(view.root).src, "c");
    // ...and stays shown when something finishes in front of it.
    act(() => view.update(<MediaLightbox {...props} items={["n", "a", "c"].map(image)} isOpen />));
    assert.equal(shownImage(view.root).src, "c");
    // A page that was only reloading brings the original back, and the view with it.
    act(() =>
      view.update(<MediaLightbox {...props} items={["n", "a", "b", "c"].map(image)} isOpen />),
    );
    assert.equal(shownImage(view.root).src, "b");
  } finally {
    act(() => renderer?.unmount());
    restoreDomStubs();
  }
});

test("a failed image stays failed through a list shift and is retried on return", () => {
  installDomStubs();
  let renderer: ReactTestRenderer | null = null;
  try {
    const props = { initialIndex: 0, onClose: () => {} };
    const items = ["a", "b"].map(image);
    act(() => {
      renderer = create(<MediaLightbox {...props} items={items} isOpen={false} />);
    });
    const view = renderer! as ReactTestRenderer;
    act(() => view.update(<MediaLightbox {...props} items={items} isOpen />));
    act(() => view.root.findByType("img").props.onError());
    assert.equal(view.root.findAllByType("img").length, 0);

    const grown = [image("n"), ...items];
    act(() => view.update(<MediaLightbox {...props} items={grown} isOpen />));
    assert.equal(view.root.findAllByType("img").length, 0);

    act(() => nextButton(view.root)!.props.onClick());
    assert.equal(shownImage(view.root).src, "b");
    act(() => previousButton(view.root)!.props.onClick());
    assert.deepEqual(shownImage(view.root), { src: "a", hidden: true, spinner: true });
  } finally {
    act(() => renderer?.unmount());
    restoreDomStubs();
  }
});

test("Next at the end steps onto the new page only, not onto a result prepended meanwhile", () => {
  installDomStubs();
  let renderer: ReactTestRenderer | null = null;
  try {
    let loads = 0;
    const props = {
      initialIndex: 1,
      onClose: () => {},
      onLoadMore: () => {
        loads++;
      },
    };
    const items = ["a", "b"].map(image);
    act(() => {
      renderer = create(<MediaLightbox {...props} items={items} isOpen={false} canLoadMore />);
    });
    const view = renderer! as ReactTestRenderer;
    act(() => view.update(<MediaLightbox {...props} items={items} isOpen canLoadMore />));
    act(() => nextButton(view.root)!.props.onClick());
    assert.ok(loads >= 1);

    // A generation finishes before the page arrives: still on "b", still last.
    const prepended = ["n", "a", "b"].map(image);
    act(() => view.update(<MediaLightbox {...props} items={prepended} isOpen isLoadingMore />));
    assert.equal(shownImage(view.root).src, "b");

    act(() =>
      view.update(
        <MediaLightbox {...props} items={[...prepended, image("c")]} isOpen canLoadMore />,
      ),
    );
    assert.equal(shownImage(view.root).src, "c");
  } finally {
    act(() => renderer?.unmount());
    restoreDomStubs();
  }
});

test("moving away before the page lands cancels the pending step", () => {
  installDomStubs();
  let renderer: ReactTestRenderer | null = null;
  try {
    const props = { initialIndex: 1, onClose: () => {}, onLoadMore: () => {} };
    const items = ["a", "b"].map(image);
    act(() => {
      renderer = create(<MediaLightbox {...props} items={items} isOpen={false} canLoadMore />);
    });
    const view = renderer! as ReactTestRenderer;
    act(() => view.update(<MediaLightbox {...props} items={items} isOpen canLoadMore />));
    act(() => nextButton(view.root)!.props.onClick());
    act(() => previousButton(view.root)!.props.onClick());
    assert.equal(shownImage(view.root).src, "a");

    act(() =>
      view.update(<MediaLightbox {...props} items={[...items, image("c")]} isOpen canLoadMore />),
    );
    assert.equal(shownImage(view.root).src, "a");
  } finally {
    act(() => renderer?.unmount());
    restoreDomStubs();
  }
});
