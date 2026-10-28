variable "resource_group" {
  description = "Existing resource group that holds every benchmark resource."
  type        = string
  default     = "rivet-vs-do-bench"
}

variable "prefix" {
  description = "Name prefix for every resource this configuration creates."
  type        = string
  default     = "rvdo"
}

variable "vnet_cidr" {
  type    = string
  default = "10.61.0.0/16"
}

variable "storage_zones" {
  description = "Availability zones of the three storage workers (eastus2 offers L8as_v5 in 1, 2 and 4)."
  type        = list(string)
  default     = ["1", "2", "4"]
}

variable "runner_zone" {
  type    = string
  default = "1"
}

variable "storage_vm_size" {
  description = "Storage worker size: an L-series VM with local NVMe."
  type        = string
  default     = "Standard_L8as_v5"
}

variable "runner_vm_size" {
  description = "RivetKit node plus load driver."
  type        = string
  default     = "Standard_D16as_v7"
}

variable "image" {
  description = "Pinned Debian 13 image."
  type = object({
    publisher = string
    offer     = string
    sku       = string
    version   = string
  })
  default = {
    publisher = "Debian"
    offer     = "debian-13"
    sku       = "13-gen2"
    version   = "0.20261026.2643"
  }
}

variable "admin_username" {
  type    = string
  default = "rivet"
}

variable "ssh_public_key_file" {
  description = "Public key that can log in to every VM."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "ssh_source_cidrs" {
  description = "Addresses allowed to SSH in. Set it to your own egress address in terraform.tfvars."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
