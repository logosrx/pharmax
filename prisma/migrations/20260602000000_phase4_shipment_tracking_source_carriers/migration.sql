-- migration: 20260602000000_phase4_shipment_tracking_source_carriers
--
-- Extend `ShipmentTrackingSource` with the direct-carrier providers
-- so polled tracking events (FedEx Track API, UPS Track API) can
-- land in `shipment_tracking_event` alongside EasyPost webhook
-- events. `EASYPOST` and `MANUAL` stay; this is purely additive.

ALTER TYPE "ShipmentTrackingSource" ADD VALUE 'FEDEX';
ALTER TYPE "ShipmentTrackingSource" ADD VALUE 'UPS';
