import { DateTime } from "luxon";
import { loadConversation, saveConversation } from "./conversationStore";
import { loadTenantConfig } from "../booking/tenant";
import * as booking from "../booking/booking";
import { SlotConflictError } from "../errors";
import { menuSlots } from "../booking/slotPicker";
import { appendPaymentLink, type PaymentOffer } from "../payments/offer";
import { config as appConfig } from "../config";
import { formatRupees, paymentActive, quoteFee } from "../payments/pricing";
import type { Channel, Slot, Tenant, TenantConfig } from "../types";

type Step =
  | "AWAITING_SERVICE"
  | "AWAITING_RESOURCE"
  | "AWAITING_SLOT"
  | "AWAITING_NAME"
  | "AWAITING_PHONE"
  | "AWAITING_CONFIRMATION"
  | "DONE";

interface ConversationState {
  step?: Step;
  serviceId?: string;
  resourceId?: string;
  offeredSlots?: Slot[];
  selectedSlot?: Slot;
  patientName?: string;
  patientPhone?: string;
}

export interface ChatOption {
  id: string;
  label: string;
}

export interface ChatResponse {
  replyText: string;
  options?: ChatOption[];
  appointmentId?: string;
  appointmentStatus?: string;
  /** The patient still has to pay: the web widget shows a Pay button; WhatsApp gets the link in replyText. */
  payment?: PaymentOffer;
}

/**
 * Deterministic numbered-menu flow — the fallback when no GEMINI_API_KEY is configured (it can only book;
 * cancel/reschedule need the agent). conversation.ts picks between this and agent.ts; neither the web route
 * nor the WhatsApp webhook contains booking logic of its own — booking.ts underneath is the whole engine.
 */
export async function handleGuidedMessage(
  tenantSlug: string,
  channel: Channel,
  externalId: string,
  messageText: string
): Promise<ChatResponse> {
  const config = await loadTenantConfig(tenantSlug);
  const { state, isNew } = await loadState(config.tenant.id, channel, externalId);

  if (isNew || !state.step || state.step === "DONE") {
    return presentServices(config, channel, externalId);
  }

  switch (state.step) {
    case "AWAITING_SERVICE":
      return onServiceSelected(config, channel, externalId, state, messageText);
    case "AWAITING_RESOURCE":
      return onResourceSelected(config, channel, externalId, state, messageText);
    case "AWAITING_SLOT":
      return onSlotSelected(config, channel, externalId, state, messageText);
    case "AWAITING_NAME":
      return onNameProvided(config, channel, externalId, state, messageText);
    case "AWAITING_PHONE":
      return onPhoneProvided(config, channel, externalId, state, messageText);
    case "AWAITING_CONFIRMATION":
      return onConfirmation(config, channel, externalId, state, messageText);
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function loadState(
  tenantId: string,
  channel: Channel,
  externalId: string
): Promise<{ state: ConversationState; isNew: boolean }> {
  const { state, isNew } = await loadConversation<ConversationState>(tenantId, channel, externalId);
  return { state, isNew };
}

const saveState = saveConversation;

// ---------------------------------------------------------------------------
// Option matching — works for both a WhatsApp user typing "2" and a web
// widget button click that sends the option's id as the message text.
// ---------------------------------------------------------------------------

function matchOption(options: ChatOption[], input: string): ChatOption | undefined {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    const option = options[Number(trimmed) - 1];
    if (option) return option;
  }
  return options.find((o) => o.id === trimmed);
}

async function resolveOption(options: ChatOption[], messageText: string): Promise<ChatOption | undefined> {
  return matchOption(options, messageText);
}

function formatSlotLabel(slot: Slot, timezone: string): string {
  return DateTime.fromISO(slot.startAt, { zone: "utc" }).setZone(timezone).toFormat("ccc dd LLL, HH:mm");
}

// ---------------------------------------------------------------------------
// Flow steps
// ---------------------------------------------------------------------------

async function presentServices(config: TenantConfig, channel: Channel, externalId: string): Promise<ChatResponse> {
  const services = config.services.filter((s) => s.active);
  if (services.length === 0) {
    return { replyText: "Sorry, this clinic hasn't set up any bookable services yet — please contact them directly." };
  }
  const options = services.map((s, i) => ({ id: s.id, label: `${i + 1}. ${s.name} (${s.durationMinutes} min)` }));
  await saveState(config.tenant.id, channel, externalId, { step: "AWAITING_SERVICE" });
  return { replyText: "Hi! Which service would you like to book?", options };
}

async function onServiceSelected(
  config: TenantConfig,
  channel: Channel,
  externalId: string,
  state: ConversationState,
  messageText: string
): Promise<ChatResponse> {
  const services = config.services.filter((s) => s.active);
  const options = services.map((s, i) => ({ id: s.id, label: `${i + 1}. ${s.name} (${s.durationMinutes} min)` }));
  const match = await resolveOption(options, messageText);
  if (!match) return { replyText: "Sorry, please pick a number from the list.", options };

  const service = services.find((s) => s.id === match.id)!;
  const resources = config.resources.filter((r) => r.active);
  if (resources.length === 0) {
    return { replyText: "Sorry, this clinic has no available practitioners right now." };
  }
  if (resources.length === 1) {
    return presentSlots(config, channel, externalId, { step: "AWAITING_SLOT", serviceId: service.id, resourceId: resources[0].id });
  }

  const resourceOptions = resources.map((r, i) => ({ id: r.id, label: `${i + 1}. ${r.name}` }));
  await saveState(config.tenant.id, channel, externalId, { step: "AWAITING_RESOURCE", serviceId: service.id });
  return { replyText: `Great, ${service.name}. Who would you like to see?`, options: resourceOptions };
}

async function onResourceSelected(
  config: TenantConfig,
  channel: Channel,
  externalId: string,
  state: ConversationState,
  messageText: string
): Promise<ChatResponse> {
  const resources = config.resources.filter((r) => r.active);
  const options = resources.map((r, i) => ({ id: r.id, label: `${i + 1}. ${r.name}` }));
  const match = await resolveOption(options, messageText);
  if (!match) return { replyText: "Please pick a number from the list.", options };

  return presentSlots(config, channel, externalId, { step: "AWAITING_SLOT", serviceId: state.serviceId, resourceId: match.id });
}

async function presentSlots(
  config: TenantConfig,
  channel: Channel,
  externalId: string,
  state: ConversationState
): Promise<ChatResponse> {
  const rangeStart = new Date();
  const rangeEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const slots = await booking.generateAvailableSlots(config, state.resourceId!, state.serviceId!, rangeStart, rangeEnd);
  const offered = menuSlots(slots, config.tenant.timezone); // a few well-spaced times per day, not eight in a row

  if (offered.length === 0) {
    await saveState(config.tenant.id, channel, externalId, { step: "AWAITING_SERVICE" });
    return {
      replyText: "Sorry, there are no available slots in the next two weeks. Please try again later or contact the clinic directly.",
    };
  }

  const options = offered.map((slot, i) => ({ id: String(i), label: `${i + 1}. ${formatSlotLabel(slot, config.tenant.timezone)}` }));
  await saveState(config.tenant.id, channel, externalId, { ...state, step: "AWAITING_SLOT", offeredSlots: offered });
  return { replyText: "Here are the next available times. Which works for you?", options };
}

async function onSlotSelected(
  config: TenantConfig,
  channel: Channel,
  externalId: string,
  state: ConversationState,
  messageText: string
): Promise<ChatResponse> {
  const offered = state.offeredSlots ?? [];
  const options = offered.map((slot, i) => ({ id: String(i), label: `${i + 1}. ${formatSlotLabel(slot, config.tenant.timezone)}` }));
  const match = await resolveOption(options, messageText);
  if (!match) return { replyText: "Please pick one of the listed times.", options };

  const slot = offered[Number(match.id)];
  await saveState(config.tenant.id, channel, externalId, { ...state, step: "AWAITING_NAME", selectedSlot: slot });
  return { replyText: "Great. What's your full name?" };
}

async function onNameProvided(
  config: TenantConfig,
  channel: Channel,
  externalId: string,
  state: ConversationState,
  messageText: string
): Promise<ChatResponse> {
  const name = messageText.trim();
  if (name.length < 2) return { replyText: "Please provide your full name." };
  await saveState(config.tenant.id, channel, externalId, { ...state, step: "AWAITING_PHONE", patientName: name });
  return { replyText: "And your phone number (with country code)?" };
}

async function onPhoneProvided(
  config: TenantConfig,
  channel: Channel,
  externalId: string,
  state: ConversationState,
  messageText: string
): Promise<ChatResponse> {
  const phone = messageText.trim();
  if (phone.length < 6) return { replyText: "That doesn't look like a valid phone number. Please try again." };

  const service = config.services.find((s) => s.id === state.serviceId)!;
  const slotLabel = formatSlotLabel(state.selectedSlot!, config.tenant.timezone);
  await saveState(config.tenant.id, channel, externalId, { ...state, step: "AWAITING_CONFIRMATION", patientPhone: phone });
  const fee = paymentActive(config.tenant)
    ? ` Fee: ${formatRupees(quoteFee(config.tenant.pricing!, config.tenant.timezone, new Date(state.selectedSlot!.startAt), service).amountPaise)}, payable online to confirm.`
    : "";
  return {
    replyText: `Please confirm: ${service.name} on ${slotLabel}.${fee}`,
    options: [
      { id: "yes", label: "1. Yes, book it" },
      { id: "no", label: "2. No, start over" },
    ],
  };
}

async function onConfirmation(
  config: TenantConfig,
  channel: Channel,
  externalId: string,
  state: ConversationState,
  messageText: string
): Promise<ChatResponse> {
  const options = [
    { id: "yes", label: "1. Yes, book it" },
    { id: "no", label: "2. No, start over" },
  ];
  const match = await resolveOption(options, messageText);

  if (!match) return { replyText: "Sorry, please reply YES to confirm or NO to start over.", options };
  if (match.id === "no") return presentServices(config, channel, externalId);

  try {
    const result = await booking.createAppointment(config, {
      serviceId: state.serviceId!,
      resourceId: state.resourceId!,
      startAt: new Date(state.selectedSlot!.startAt),
      patient: { name: state.patientName!, phone: state.patientPhone! },
      channel,
    });
    await saveState(config.tenant.id, channel, externalId, { step: "DONE" });
    if (result.payment) {
      const text = `Almost done! Please pay ${result.payment.amount} to confirm your appointment. The time is held for you for ${appConfig.payments.holdMinutes} minutes.`;
      return {
        replyText: channel === "whatsapp" ? appendPaymentLink(text, result.payment) : text,
        payment: result.payment,
        appointmentId: result.appointmentId,
        appointmentStatus: result.status,
      };
    }
    const statusText = result.status === "CONFIRMED" ? "confirmed" : "received and is awaiting confirmation from our staff";
    return {
      replyText: `Thank you! Your appointment request has been ${statusText}. We'll be in touch if anything changes.`,
      appointmentId: result.appointmentId,
      appointmentStatus: result.status,
    };
  } catch (err) {
    if (err instanceof SlotConflictError) {
      return presentSlots(config, channel, externalId, { serviceId: state.serviceId, resourceId: state.resourceId });
    }
    throw err;
  }
}
