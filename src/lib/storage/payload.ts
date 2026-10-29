import type { NewBookingRequest } from "./types";

/** Approval payload for a booking request; both stores write the same shape. */
export function bookingPayload(input: NewBookingRequest): Record<string, unknown> {
  return {
    serviceId: input.serviceId,
    startsAt: input.startsAt,
    customerRef: input.customerRef,
    customerName: input.customerName ?? null,
    customerContact: input.customerContact ?? null,
  };
}
