# Zepto MCP APIs

## Product Search
| API | Description |
|-----|-------------|
| `search_products` | Search for a **single** product in the Zepto catalog. Returns prices, availability, and details. |
| `search_multiple_products` | Search for **multiple** products in parallel (e.g., "chips and coke"). |
| `get_product_details` | Get detailed info about a specific product — specs, ratings, return policy, seller info. |
| `get_past_order_items` | Get frequently ordered products from last 30+ orders. **Mandatory first step** before any search. |

## Cart Management
| API | Description |
|-----|-------------|
| `view_cart` | View current cart contents with item details and quantities. |
| `update_cart` | Add, update quantities, or remove items from the cart. |

## Address & Location
| API | Description |
|-----|-------------|
| `list_saved_addresses` | List all saved delivery addresses for the user. |
| `select_saved_address` | Select a saved address and set the corresponding store context. |
| `add_saved_address` | Create and save a new delivery address with coordinates and details. |
| `update_drop_zone` | Update delivery drop zone for event/venue locations (required when prompted). |
| `get_location_serviceability` | Check if Zepto services a given lat/lng location and get nearby store info. |

## Store
| API | Description |
|-----|-------------|
| `select_store` | Select a store for the current session. All subsequent operations use this store. |

## Order Placement
| API | Description |
|-----|-------------|
| `create_order` | Place a **COD** (Cash on Delivery) order. Supports preview before confirmation. |
| `create_online_payment_order` | Place an order via **online payment** link (UPI, cards, etc.). |
| `create_wallet_order` | Place an order using **Zepto Cash** (wallet balance must cover the total). |
| `create_upi_reserve_pay_order` | Place an order using **UPI Reserve Pay** (NPCI + Razorpay). |
| `get_payment_methods` | Get available payment methods (COD, online, wallet) for the current cart. |
| `check_payment_status` | Check/poll payment status for online payment orders. |

## Order History
| API | Description |
|-----|-------------|
| `list_order_history` | List past orders with status, items, and delivery info. Supports pagination. |
| `get_order_detail` | Get detailed info about a specific order (items, pricing, delivery). |

## User Management
| API | Description |
|-----|-------------|
| `get_user_details` | Fetch user profile — name, email, phone, referral code, account status. |
| `update_user_name` | Update user's full name to complete registration. |

## Widget (ChatGPT Apps only)
| API | Description |
|-----|-------------|
| `zepto_shop` | Opens a full interactive shopping widget. Not intended for CLI/MCP clients. |

## Typical Workflow
1. `get_user_details` → check registration
2. `list_saved_addresses` → `select_saved_address` → set delivery context
3. `get_past_order_items` → `search_products` / `search_multiple_products` → browse products
4. `update_cart` → add items
5. `get_payment_methods` → choose payment
6. `create_order` / `create_online_payment_order` / `create_wallet_order` → place order
