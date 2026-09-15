-- =========================================================
-- Offer Management Schema (v2)
-- =========================================================

-- 1. OFFER TABLE
CREATE TABLE offer (
    offer_id        SERIAL PRIMARY KEY,
    offer_name      VARCHAR(150) NOT NULL,
    outlet_id       INT NOT NULL,
    start_date      DATE NOT NULL,
    end_date        DATE NOT NULL,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_offer_outlet
        FOREIGN KEY (outlet_id) REFERENCES outlet(outlet_id),
    CONSTRAINT chk_offer_dates CHECK (end_date >= start_date)
);

-- 2. OFFER_MENU TABLE (items within an offer)
CREATE TABLE offer_menu (
    offer_menu_id   SERIAL PRIMARY KEY,
    offer_id        INT NOT NULL,
    item_name       VARCHAR(150) NOT NULL,
    unit_price      NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
    offer_price     NUMERIC(10,2) NOT NULL CHECK (offer_price >= 0),
    max_quantity    INT NOT NULL DEFAULT 1 CHECK (max_quantity > 0),
    description     VARCHAR(500),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_offer_menu_offer
        FOREIGN KEY (offer_id) REFERENCES offer(offer_id) ON DELETE CASCADE,
    CONSTRAINT chk_offer_price CHECK (offer_price <= unit_price),

    -- Needed so offer_order_item can enforce (offer_id, offer_menu_id) pairing
    CONSTRAINT uq_offer_menu_offer_menu UNIQUE (offer_id, offer_menu_id)
);

-- =========================================================
-- Sequence for order_token (auto-sequence)
-- =========================================================
CREATE SEQUENCE offer_order_token_seq
    START WITH 1000
    INCREMENT BY 1;

-- 3. OFFER_ORDER TABLE
CREATE TABLE offer_order (
    order_id        SERIAL PRIMARY KEY,
    order_token     INT NOT NULL DEFAULT NEXTVAL('offer_order_token_seq') UNIQUE,
    customer_name   VARCHAR(150) NOT NULL,
    phone_number    VARCHAR(15) NOT NULL,
    order_status    VARCHAR(20) NOT NULL DEFAULT 'Confirm',
    offer_id        INT NOT NULL,
    total_amount    NUMERIC(10,2) NOT NULL CHECK (total_amount >= 0),
    created_date    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_offer_order_offer
        FOREIGN KEY (offer_id) REFERENCES offer(offer_id),
    CONSTRAINT chk_order_status
        CHECK (order_status IN ('Confirm', 'Cancel', 'Preparing', 'Ready')),

    -- Needed so offer_order_item can enforce (offer_id, order_id) pairing
    CONSTRAINT uq_offer_order_offer_order UNIQUE (order_id, offer_id)
);

-- 4. OFFER_ORDER_ITEM TABLE
CREATE TABLE offer_order_item (
    order_item_id   SERIAL PRIMARY KEY,
    order_id        INT NOT NULL,
    offer_id        INT NOT NULL,   -- denormalized, enables composite FK below
    offer_menu_id   INT NOT NULL,
    quantity        INT NOT NULL CHECK (quantity > 0 AND quantity <= 10),

    -- Ensures the order_id truly belongs to offer_id
    CONSTRAINT fk_order_item_order_offer
        FOREIGN KEY (order_id, offer_id)
        REFERENCES offer_order(order_id, offer_id)
        ON DELETE CASCADE,

    -- Ensures the offer_menu_id truly belongs to offer_id
    CONSTRAINT fk_order_item_menu_offer
        FOREIGN KEY (offer_id, offer_menu_id)
        REFERENCES offer_menu(offer_id, offer_menu_id)
);

-- =========================================================
-- Helpful Indexes
-- =========================================================
CREATE INDEX idx_offer_outlet ON offer(outlet_id);
CREATE INDEX idx_offer_menu_offer ON offer_menu(offer_id);
CREATE INDEX idx_offer_order_offer ON offer_order(offer_id);
CREATE INDEX idx_offer_order_status_date ON offer_order(offer_id, order_status, created_date);
CREATE INDEX idx_offer_order_item_order ON offer_order_item(order_id);
CREATE INDEX idx_offer_order_item_menu ON offer_order_item(offer_menu_id);


CREATE POLICY "Staff can create offers for their outlet"
ON offer
FOR INSERT
TO authenticated
WITH CHECK (
    true
);

CREATE POLICY "Authenticated users can create offer menu items"
ON offer_menu
FOR INSERT
TO authenticated
WITH CHECK (true);

--one order per offer per phone number
ALTER TABLE offer_order
  ADD CONSTRAINT uq_offer_order_phone_per_offer UNIQUE (offer_id, phone_number);

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_offer_order_customer_name_trgm ON offer_order USING gin (customer_name gin_trgm_ops);
CREATE INDEX idx_offer_order_phone_trgm ON offer_order USING gin (phone_number gin_trgm_ops);