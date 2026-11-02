import { useCallback, useEffect, useRef, useState } from "react";
import { prepareImageForUpload } from "../lib/image-compress";

// File picking and clipboard images share compression, errors and cancellation.
export function useImageAttachment() {
  const [attachment, setAttachment] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const generation = useRef(0);
  const clear = useCallback(() => {
    generation.current++;
    setAttachment(null);
    setError(null);
    setPreparing(false);
  }, []);
  useEffect(() => () => { generation.current++; }, []);
  const attach = useCallback(async (file: File) => {
    const request = ++generation.current;
    setAttachment(null);
    setError(null);
    setPreparing(true);
    try {
      const image = await prepareImageForUpload(file);
      if (generation.current === request) setAttachment(image);
    } catch (err) {
      if (generation.current === request) setError(err instanceof Error ? err.message : "Could not load that image.");
    } finally {
      if (generation.current === request) setPreparing(false);
    }
  }, []);
  return { attachment, error, preparing, attach, clear };
}
