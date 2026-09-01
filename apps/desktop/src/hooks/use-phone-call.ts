// Phone-number management — local stub.
//
// franklin-run provisions Twilio-style numbers through a hosted /api endpoint
// paid via browser x402. Locally, number management would go through the
// Franklin CLI's phone tool; that surface isn't wired over the agent socket
// yet, so this stub keeps the PhonePanel mounted and inert (placing a call
// still works from chat, via the agent's make_phone_call tool).
//
// TODO: back this with agent.request("phone.list" / "phone.buy" / …) once the
// CLI exposes those RPCs.

import { useCallback, useState } from "react";

export interface PhoneNumber {
  phone_number: string;
  expires_at?: string | number;
}

export function usePhoneCall() {
  const [numbers] = useState<PhoneNumber[]>([]);
  const [numbersError] = useState<string | null>(null);
  const [loadingNumbers] = useState(false);
  const [actionBusy] = useState(false);

  const loadNumbers = useCallback(async () => {
    /* no-op until the CLI exposes phone RPCs over the agent socket */
  }, []);
  const buyNumber = useCallback(async (_country: string, _areaCode?: string) => {}, []);
  const releaseNumber = useCallback(async (_phone: string) => {}, []);
  const renewNumber = useCallback(async (_phone: string) => {}, []);

  return {
    isConnected: false,
    numbers,
    numbersError,
    loadingNumbers,
    actionBusy,
    loadNumbers,
    buyNumber,
    releaseNumber,
    renewNumber,
  };
}
